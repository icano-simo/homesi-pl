/**
 * Targeted re-evaluation of non-manual transactions.
 *
 * Used when a Cost Center or Split Rule is modified/deleted.
 * Covers assignment_origin = 'rule', 'rule_split', NULL (legacy rows), and any
 * other non-'manual' value.  Transactions with assignment_origin = 'manual' are
 * NEVER touched here.
 */

import { evaluateCostCenterRules } from "@/lib/evaluate-cost-center-rules";
import { createServerClient } from "@/lib/supabase-server";
import { syncRuleSplitAllocations, type RuleSplitEntry } from "@/lib/sync-rule-split-allocations";
import type {
  PLTransaction,
  SplitRule,
  SplitRuleWithDetails,
  SplitRuleCondition,
  SplitRuleAllocation,
} from "@/types";

type SupabaseClient = ReturnType<typeof createServerClient>;

// ─── Clasificacion del prestamo, para las reglas de centro de coste ──────────

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * LAS CLASIFICACIONES SALEN DEL ESPEJO, NO DE `loan_officials`
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Esto leia `finance_division.loan_officials`, que es el archivo que se sube a
 * mano y que el resto de la app abandono: **436 filas y la ultima del
 * 2026-08-20**, contra 800 prestamos con `is_b2b` en el espejo. Es la misma
 * tabla, y el mismo motivo, por el que se migraron las rutas del modulo por
 * loan officer.
 *
 * Ahora cada campo viene de donde vive de verdad:
 *
 *     b2b                loan_manual_flags.b2b  O  loan_records_v2.is_b2b
 *     processing         loan_manual_flags.processing
 *     support_on_demand  loan_manual_flags.support_on_demand
 *     affinity           loan_records_v2.is_affinity
 *     lead_source_lo     loan_records_v2.lead_source
 *     bd_owner           loan_records_v2.bd
 *     recruitment        loan_records_v2.strategy = 'Recruitment'
 *
 * ⚠ `b2b` ES LA UNION DE LAS DOS, no una con la otra de respaldo. Es la misma
 * definicion con la que se miden los prestamos B2B en el resto del proyecto:
 * la marca manual y la de Salesforce son dos maneras de decirlo y ninguna
 * manda sobre la otra.
 *
 * ⚠ NO SE FILTRA POR `is_closed`. `getClosedLoans` si lo hace, porque contesta
 * "que cerro este mes"; aqui la pregunta es "de que prestamo es este apunte",
 * y el P&L tiene lineas de prestamos que aun no han cerrado. Filtrar dejaria
 * sus clasificaciones en blanco y el evaluador las leeria como un no.
 *
 * ⚠ `recruitment` FUE EL ULTIMO EN SALIR DE `loan_officials`, y hubo que
 * abrirle la puerta. El espejo no tenia `is_recruitment` --solo `is_affinity`,
 * `is_b2b`, `is_closed` y `is_second_lien_heloc`-- y BigQuery tampoco la
 * expone. Pero tampoco expone `is_b2b`: el sync la DERIVA de `strategy`, y la
 * misma puerta servia. Ahora simo-sync hace las dos, pegadas:
 *
 *     "strategy = 'B2B'         AS is_b2b",
 *     "strategy = 'Recruitment' AS is_recruitment",
 *
 * ⚠ AQUI SE LEE `strategy`, NO LA COLUMNA `is_recruitment`, Y ES DELIBERADO.
 * Son el mismo predicado --la columna ES `strategy = 'Recruitment'` calculada
 * en el sync-- pero leer la columna ata este archivo a un orden de despliegue:
 *
 *   1. un `select` de una columna que aun no existe NO devuelve null, devuelve
 *      un error de PostgREST, y se lleva por delante TODA la clasificacion.
 *      Comprobado: "column loan_records_v2.is_recruitment does not exist"
 *      rompe el upload del P&L, el Reapply y la entrada manual a la vez.
 *   2. y entre aplicar la columna y el primer sync estaria a NULL en las 5.114
 *      filas, asi que un Reapply en esa ventana desasignaria CC04-Recruitment
 *      entero sin que nada fallara.
 *
 * Leyendo `strategy` no hay ventana ni orden: la columna del espejo ya esta
 * llena hoy, y da la misma respuesta. `is_recruitment` se añade igualmente,
 * para que el espejo tenga la pareja completa y para quien la consuma desde
 * fuera; este archivo puede pasar a leerla cuando el sync haya corrido, y sera
 * un cambio de una linea sin consecuencia.
 *
 * ⚠ Y CAMBIA UNA SEMANTICA. `strategy` es un valor UNICO con precedencia
 * --Affinity > NPPM > Recruitment > B2B > Own Production-- mientras
 * `loan_officials` tenia `b2b` y `recruitment` como casillas independientes.
 * Un prestamo ya no puede ser las dos cosas. Medido: de las 18 marcadas
 * recruitment a mano, 17 casan por strategy y UNA no --747002052489, que el
 * espejo llama `B2B`--. No es una perdida: es que el espejo tiene una regla
 * escrita y la otra fuente son dos casillas, y ademas resuelve el unico
 * conflicto que quedaba vivo.
 */
type LoanClassification = {
  loan_number: string;
  b2b: boolean;
  processing: boolean;
  support_on_demand: boolean;
  affinity: boolean;
  recruitment: boolean;
  lead_source_lo: string | null;
  bd_owner: string | null;
};

/** Paginado: un select sin rango se corta en 1000 filas en este proyecto. */
async function todas<T>(
  /* PromiseLike y no Promise: el builder de supabase-js es "thenable" pero no
     es una Promise, asi que tiparlo como tal no compila. */
  page: (desde: number, hasta: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await page(i, i + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    out.push(...(data as T[]));
    if (data.length < 1000) break;
  }
  return out;
}

/**
 * Las clasificaciones de cada prestamo, por `loan_number`, para enriquecer las
 * transacciones antes de evaluar las reglas de centro de coste.
 */
export async function loadLoanClassifications(
  supabase: SupabaseClient
): Promise<Map<string, LoanClassification>> {
  const ar = createServerClient("activity_report");

  const [espejo, manuales] = await Promise.all([
    todas<Record<string, unknown>>((d, h) =>
      ar.from("loan_records_v2")
        .select("loan_number,is_b2b,strategy,is_affinity,lead_source,bd")
        .not("loan_number", "is", null)
        .order("loan_number", { ascending: true })
        .range(d, h)),
    todas<Record<string, unknown>>((d, h) =>
      supabase.from("loan_manual_flags")
        .select("loan_number,b2b,support_on_demand,processing")
        .order("loan_number", { ascending: true })
        .range(d, h)),
  ]);

  const flags = new Map<string, Record<string, unknown>>();
  for (const r of manuales) flags.set(String(r.loan_number), r);
  const map = new Map<string, LoanClassification>();
  const poner = (loan: string, espejoRow: Record<string, unknown> | null) => {
    const f = flags.get(loan);
    map.set(loan, {
      loan_number: loan,
      b2b: f?.b2b === true || espejoRow?.is_b2b === true,
      processing: f?.processing === true,
      support_on_demand: f?.support_on_demand === true,
      affinity: espejoRow?.is_affinity === true,
      recruitment: espejoRow?.strategy === "Recruitment",
      lead_source_lo: (espejoRow?.lead_source as string) ?? null,
      bd_owner: (espejoRow?.bd as string) ?? null,
    });
  };

  for (const r of espejo) poner(String(r.loan_number), r);
  /*
   * ⚠ Y LOS QUE SOLO ESTAN EN LAS OTRAS DOS TAMBIEN. Un prestamo con marca
   * manual pero sin fila en el espejo existe --las marcas se ponen a mano y no
   * esperan a que Salesforce lo tenga-- y dejarlo fuera seria perder justo la
   * clasificacion que alguien puso a proposito.
   */
  for (const loan of flags.keys()) {
    if (!map.has(loan)) poner(loan, null);
  }
  return map;
}

/**
 * Pega las clasificaciones del prestamo sobre una transaccion.
 *
 * Si no hay `loan_number`, o viene incompleto, la transaccion pasa intacta y el
 * evaluador trata esos campos como ausentes -- que NO es lo mismo que false: un
 * `null` en un campo de prestamo hace que la condicion no case, en vez de casar
 * con "no". Ver `evaluate-cost-center-rules.ts`.
 */
export function enrichTxWithLoanClassifications(
  tx: Record<string, unknown>,
  loMap: Map<string, LoanClassification>
): Record<string, unknown> {
  const loanNum = tx.loan_number as string | null | undefined;
  const incomplete = tx.loan_number_incomplete as boolean | null | undefined;
  if (!loanNum || incomplete) return tx;
  const lo = loMap.get(loanNum);
  if (!lo) return tx;
  return {
    ...tx,
    b2b: lo.b2b,
    processing: lo.processing,
    support_on_demand: lo.support_on_demand,
    affinity: lo.affinity,
    recruitment: lo.recruitment,
    lead_source_lo: lo.lead_source_lo,
    bd_owner: lo.bd_owner,
  };
}

export type ReevalStats = {
  reevaluated: number;
  reassigned: number;
  unassigned: number;
  conflicts: number;
};

const TX_FIELDS =
  "id,gl_code,gl_name,branch,vendor,check_description," +
  "ref_numb,category_5,category_6,doc_type,month,year,debit,credit,movement," +
  "loan_number,loan_number_incomplete";

const UPDATE_PARALLEL = 100;
const FETCH_BATCH = 1000;

/**
 * Loads every transaction of an upload, in the shape the rule evaluator wants.
 *
 * PostgREST caps an unbounded select at 1000 rows on this project — measured,
 * not assumed: `select("id")` with no range returns exactly 1000 of 26,165. The
 * three uploaders each read their freshly inserted rows to evaluate cost-center
 * rules, so without paging, an 11,092-row file would only ever have its first
 * 1000 rows evaluated and the rest would sit unassigned with no error anywhere.
 *
 * Ordered by id, which is a stable unique key. Ordering by anything non-unique
 * (a date, a gl_code) lets rows shift between pages and be read twice or
 * skipped entirely at the boundaries.
 */
export async function fetchUploadTxsForRules(
  supabase: SupabaseClient,
  uploadId: string,
): Promise<Array<{ id: string } & Record<string, unknown>>> {
  const rows: Array<{ id: string } & Record<string, unknown>> = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("pl_transactions")
      .select(TX_FIELDS)
      .eq("upload_id", uploadId)
      .order("id", { ascending: true })
      .range(offset, offset + FETCH_BATCH - 1);
    if (error) throw new Error(`fetch upload txs: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...(data as unknown as Array<{ id: string } & Record<string, unknown>>));
    if (data.length < FETCH_BATCH) break;
    offset += FETCH_BATCH;
  }
  return rows;
}

/**
 * Loads all split rules with their conditions and allocations from the database.
 * Call AFTER any mutation so the result reflects the current state.
 */
export async function loadAllSplitRules(supabase: SupabaseClient): Promise<SplitRuleWithDetails[]> {
  const [{ data: rules }, { data: conditions }, { data: allocations }] = await Promise.all([
    supabase.from("split_rules").select("*"),
    supabase.from("split_rule_conditions").select("*").order("sequence"),
    supabase.from("split_rule_allocations").select("*").order("display_order"),
  ]);

  const condsByRule = new Map<string, SplitRuleCondition[]>();
  for (const c of (conditions ?? []) as SplitRuleCondition[]) {
    const arr = condsByRule.get(c.split_rule_id) ?? [];
    arr.push(c);
    condsByRule.set(c.split_rule_id, arr);
  }

  const allocsByRule = new Map<string, SplitRuleAllocation[]>();
  for (const a of (allocations ?? []) as SplitRuleAllocation[]) {
    const arr = allocsByRule.get(a.split_rule_id) ?? [];
    arr.push(a);
    allocsByRule.set(a.split_rule_id, arr);
  }

  return (rules ?? []).map((sr) => ({
    ...(sr as SplitRule),
    conditions: condsByRule.get(sr.id as string) ?? [],
    allocations: allocsByRule.get(sr.id as string) ?? [],
  }));
}

/**
 * Fetches the IDs of all re-evaluable transactions for a given Cost Center.
 * Excludes only assignment_origin = 'manual'.
 */
export async function getRuleAssignedTxIds(
  supabase: SupabaseClient,
  ccId: string,
): Promise<string[]> {
  const ids: string[] = [];
  let offset = 0;

  while (true) {
    const { data } = await supabase
      .from("pl_transactions")
      .select("id")
      .eq("cost_center_id", ccId)
      .or("assignment_origin.neq.manual,assignment_origin.is.null")
      .order("id", { ascending: true })
      .range(offset, offset + 999);

    if (!data || data.length === 0) break;
    ids.push(...(data as { id: string }[]).map((r) => r.id));
    if (data.length < 1000) break;
    offset += 1000;
  }

  return ids;
}

/**
 * Re-evaluates a specific set of transactions against the current ruleset.
 * Updates pl_transactions and syncs conflict_snapshots.
 */
export async function reevaluateRuleAssigned(
  supabase: SupabaseClient,
  txIds: string[],
  splitRules: SplitRuleWithDetails[] = [],
): Promise<ReevalStats> {
  if (txIds.length === 0) {
    return { reevaluated: 0, reassigned: 0, unassigned: 0, conflicts: 0 };
  }

  type TxRow = { id: string } & Record<string, unknown>;
  const [txsRaw, loMap] = await Promise.all([
    (async () => {
      const result: TxRow[] = [];
      for (let i = 0; i < txIds.length; i += 1000) {
        const chunk = txIds.slice(i, i + 1000);
        const { data } = await supabase.from("pl_transactions").select(TX_FIELDS).in("id", chunk);
        if (data) result.push(...(data as unknown as TxRow[]));
      }
      return result;
    })(),
    loadLoanClassifications(supabase),
  ]);
  const txs = txsRaw.map((tx) => enrichTxWithLoanClassifications(tx, loMap) as TxRow);

  const toUpdate: {
    id: string;
    cost_center_id: string | null;
    cost_center_status: string;
    cost_center_conflicts: string[] | null;
    assignment_origin: string | null;
    conflict_type: string | null;
    operational_pct: number;
  }[] = [];
  const ruleSplitEntries: RuleSplitEntry[] = [];
  const snapshotUpserts: { transaction_id: string; conflicting_cc_ids: string[] }[] = [];
  const snapshotDeletes: string[] = [];

  for (const tx of txs) {
    const r = evaluateCostCenterRules(tx as unknown as PLTransaction, splitRules);
    const origin =
      r.cost_center_status !== "assigned" ? null : r.rule_splits ? "rule_split" : "rule";

    if (r.rule_splits) ruleSplitEntries.push({ transaction_id: tx.id, splits: r.rule_splits });
    toUpdate.push({
      id: tx.id,
      cost_center_id: r.cost_center_id,
      cost_center_status: r.cost_center_status,
      cost_center_conflicts: r.cost_center_conflicts.length > 0 ? r.cost_center_conflicts : null,
      assignment_origin: origin,
      conflict_type: r.conflict_type ?? null,
      operational_pct: r.operational_pct,
    });

    if (r.cost_center_status === "conflict") {
      snapshotUpserts.push({ transaction_id: tx.id, conflicting_cc_ids: r.cost_center_conflicts });
    } else {
      snapshotDeletes.push(tx.id);
    }
  }

  for (let i = 0; i < toUpdate.length; i += UPDATE_PARALLEL) {
    await Promise.all(
      toUpdate.slice(i, i + UPDATE_PARALLEL).map((u) =>
        supabase
          .from("pl_transactions")
          .update({
            cost_center_id: u.cost_center_id,
            cost_center_status: u.cost_center_status,
            cost_center_conflicts: u.cost_center_conflicts,
            assignment_origin: u.assignment_origin,
            conflict_type: u.conflict_type,
            operational_pct: u.operational_pct,
          })
          .eq("id", u.id)
      )
    );
  }

  await syncRuleSplitAllocations(supabase, txs.map((t) => t.id), ruleSplitEntries);

  const now = new Date().toISOString();

  if (snapshotUpserts.length > 0) {
    for (let i = 0; i < snapshotUpserts.length; i += 200) {
      await supabase.from("conflict_snapshots").upsert(
        snapshotUpserts.slice(i, i + 200).map((s) => ({
          transaction_id: s.transaction_id,
          conflicting_cc_ids: s.conflicting_cc_ids,
          is_resolved: false,
          resolved_cc_id: null,
          resolved_at: null,
          updated_at: now,
        })),
        { onConflict: "transaction_id" }
      );
    }
  }

  if (snapshotDeletes.length > 0) {
    for (let i = 0; i < snapshotDeletes.length; i += 200) {
      await supabase
        .from("conflict_snapshots")
        .delete()
        .in("transaction_id", snapshotDeletes.slice(i, i + 200));
    }
  }

  return {
    reevaluated: txs.length,
    reassigned: toUpdate.filter((u) => u.cost_center_status === "assigned").length,
    unassigned: toUpdate.filter((u) => u.cost_center_status === "unassigned").length,
    conflicts: toUpdate.filter((u) => u.cost_center_status === "conflict").length,
  };
}
