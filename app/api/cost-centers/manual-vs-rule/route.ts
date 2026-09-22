import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { requireSession } from "@/lib/auth";
import { evaluateCostCenterRules } from "@/lib/evaluate-cost-center-rules";
import {
  loadAllSplitRules,
  loadLoanClassifications,
  enrichTxWithLoanClassifications,
} from "@/lib/reevaluate-rule-assigned";
import type { PLTransaction, SplitRuleWithDetails } from "@/types";

export const dynamic = "force-dynamic";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * DONDE LA ASIGNACION MANUAL DICE UNA COSA Y LA REGLA DIRIA OTRA
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Una asignacion manual es PERMANENTE: el Reapply la salta antes de evaluar
 * nada, y eso esta bien -- para eso existe. Pero hasta ahora no habia forma de
 * revisarlas, y una decision que nadie puede volver a mirar deja de ser una
 * decision y pasa a ser un sedimento.
 *
 * ⚠ NO ES UNA COLA DE ERRORES: ES DONDE LAS REGLAS SE QUEDARON CORTAS. Al
 * mirar las 21 primeras, en TODAS el humano habia elegido un cubo mas
 * especifico que el de la regla -- "Excluded Employees" en vez de "Excluded
 * Transactions", "One timers" en vez de "Excluded Transactions". La lista no
 * dice quien se equivoco: dice donde la regla no llega.
 *
 * ⚠ Y NO SE LISTAN LAS 1.930 EN LAS QUE LA REGLA NO OPINA, que es la mayoria.
 * Medido el 2026-09-21 sobre las 2.366 filas manuales:
 *
 *     la regla no dice nada (unassigned)   1.930   -481.278,26
 *     DESACUERDO REAL                          21    -63.393,14
 *     la regla da conflicto                     8       +416,00
 *
 * Las 1.930 no son un desacuerdo: son filas que alguien asigno a mano
 * PRECISAMENTE porque ninguna regla las cubre. Contarlas como discrepancia
 * convertia 29 filas revisables en "medio millon en desacuerdo silencioso",
 * que es alarmante, plausible y falso. Se devuelven como un numero, no como
 * una lista, para que se vea que no se esconden.
 *
 * ⚠ EL IMPORTE NO CAMBIA, CAMBIA EL DESTINO. En ninguna de estas filas hay
 * dinero en juego: hay dinero en un centro de coste distinto del que dirian
 * las reglas. Llamar "diferencia" a la cifra haria pensar lo contrario.
 */

const SEL =
  "id,gl_code,gl_name,branch,vendor,check_description,ref_numb,category_5,category_6," +
  "doc_type,month,year,debit,credit,movement,assignment_origin,loan_number," +
  /*
   * ⚠ NO SE PIDE `assigned_at`, Y NO ES UN OLVIDO: ESA COLUMNA NO EXISTE.
   * Se quito de la migracion al ver que `pl_transactions.updated_at` ya es la
   * fecha de asignacion -- el trigger `trg_pl_transactions_cc_updated_at` solo
   * la mueve cuando cambia el ceco. Pedir una columna que no esta no devuelve
   * null: revienta el select entero con un error de PostgREST y se lleva la
   * pestaña por delante.
   */
  "loan_number_incomplete,cost_center_id,cost_center_status,assigned_by,updated_at";

export interface ManualVsRuleRow {
  id: string;
  branch: string | null;
  gl_code: string | null;
  gl_name: string | null;
  month: string | null;
  year: number | null;
  movement: number;
  loan_number: string | null;
  description: string | null;
  /** Quien, cuando consta. Null en todo lo anterior al rastro. */
  assigned_by: string | null;
  /** Cuando cambio la asignacion. Es `updated_at`, que el trigger mueve solo
   *  al cambiar el ceco -- no hay una `assigned_at` aparte a proposito. */
  assigned_at: string | null;
}

export interface ManualVsRuleFamily {
  key: string;
  manualCc: string;
  ruleCc: string;
  /** "assigned" o "conflict": que diria la regla. */
  ruleStatus: string;
  rows: number;
  /** Lo que hay en el ceco manual. NO es una diferencia de importe. */
  amount: number;
  accounts: string[];
  branches: string[];
  items: ManualVsRuleRow[];
}

/**
 * Una fila cuyo split de transaccion apunta a OTRO centro de coste que la
 * propia fila. La pantalla sigue al split, asi que lo que se ve no es lo que
 * dice `cost_center_id`.
 */
export interface DesyncRow {
  id: string;
  branch: string | null;
  gl_code: string | null;
  month: string | null;
  year: number | null;
  movement: number;
  loan_number: string | null;
  /** Lo que dice la columna de la fila. */
  rowCc: string;
  /** Lo que dice su split, que es lo que se pinta. */
  splitCc: string;
}

export interface ManualVsRuleResult {
  families: ManualVsRuleFamily[];
  totals: { rows: number; amount: number };
  /** Manuales donde la regla no opina. No son desacuerdo; se cuentan y ya. */
  ruleSilent: { rows: number; amount: number };
  manualTotal: number;
  /** Cuantas de las listadas tienen autor y fecha. Hoy, casi ninguna. */
  withTrail: number;
  /**
   * ─────────────────────────────────────────────────────────────────────────
   * LA FILA DICE UN CECO Y SU SPLIT DICE OTRO
   * ─────────────────────────────────────────────────────────────────────────
   *
   * Es la misma pregunta que el resto de la pestaña --"esto esta en un centro
   * distinto del que deberia"-- vista desde el otro lado: aqui no discrepan el
   * humano y la regla, discrepan la fila y su propio split.
   *
   * ⚠ LA REJILLA SIGUE AL SPLIT. Con filtro de centro de coste, el pivot llama
   * a `fanOutBySplits`, que SOBRESCRIBE `cost_center_id` con el del split. Un
   * `assign_type='transaction'` apunta a una fila concreta por su id, asi que
   * un UPDATE directo a `cost_center_id` NO MUEVE NADA en pantalla.
   *
   * ⚠ Y NADA LO AVISA: ni un error, ni un cero raro. El 2026-09-21 se movieron
   * 24 filas de CC01 a CC03 con un UPDATE directo; en la base quedaron en
   * CC03 y en la pantalla en CC01, y el sintoma fueron DOS MESES VACIOS que
   * costaron tres rondas encontrar. Esta seccion existe para que la proxima se
   * vea sola.
   *
   * ⚠ SOLO LOS SPLITS DE UNA LINEA AL 100%. En un reparto 60/40 la fila solo
   * puede coincidir con uno de los dos lados, asi que contarlos daria 1.394
   * falsos positivos donde las desincronizadas de verdad eran 24.
   */
  desync: DesyncRow[];
}

export async function GET() {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const sb = createServerClient();
  const [rules, loMap, ccs] = await Promise.all([
    loadAllSplitRules(sb),
    loadLoanClassifications(sb),
    sb.from("cost_centers").select("id,name")
      .then((r) => new Map((r.data ?? []).map((c: { id: string; name: string }) => [c.id, c.name]))),
  ]);
  const nombre = (id: string | null) => (id ? (ccs.get(id) ?? "(centro desconocido)") : "(sin centro de coste)");

  type Fila = Record<string, unknown> & { id: string };
  const filas: Fila[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await sb
      .from("pl_transactions")
      .select(SEL)
      .in("assignment_origin", ["manual", "split_propagated"])
      .order("id", { ascending: true })
      .range(off, off + 999);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data?.length) break;
    filas.push(...(data as unknown as Fila[]));
    if (data.length < 1000) break;
  }

  const fams = new Map<string, ManualVsRuleFamily>();
  let silentRows = 0, silentAmount = 0, withTrail = 0;

  for (const tx of filas) {
    const r = evaluateCostCenterRules(
      enrichTxWithLoanClassifications(tx, loMap) as unknown as PLTransaction,
      rules as SplitRuleWithDetails[],
    );
    const mov = Number(tx.movement ?? 0);
    const igual = r.cost_center_id === tx.cost_center_id && r.cost_center_status === tx.cost_center_status;
    if (igual) continue;

    /* La regla no opina: no es un desacuerdo. Ver la nota de arriba. */
    if (r.cost_center_status === "unassigned") { silentRows++; silentAmount += mov; continue; }
    /* Sin ceco manual no hay nada que contrastar: la regla simplemente llega
       donde nadie llego. Tampoco es un desacuerdo. */
    if (!tx.cost_center_id) { silentRows++; silentAmount += mov; continue; }

    const manualCc = nombre(tx.cost_center_id as string);
    const ruleCc = r.cost_center_status === "conflict" ? "(conflicto entre reglas)" : nombre(r.cost_center_id);
    const key = `${manualCc}→${ruleCc}`;
    const f = fams.get(key) ?? {
      key, manualCc, ruleCc, ruleStatus: r.cost_center_status,
      rows: 0, amount: 0, accounts: [], branches: [], items: [],
    };
    f.rows++; f.amount += mov;
    if (tx.gl_code && !f.accounts.includes(tx.gl_code as string)) f.accounts.push(tx.gl_code as string);
    if (tx.branch && !f.branches.includes(tx.branch as string)) f.branches.push(tx.branch as string);
    if (tx.assigned_by) withTrail++;
    f.items.push({
      id: tx.id,
      branch: (tx.branch as string) ?? null,
      gl_code: (tx.gl_code as string) ?? null,
      gl_name: (tx.gl_name as string) ?? null,
      month: (tx.month as string) ?? null,
      year: (tx.year as number) ?? null,
      movement: mov,
      loan_number: (tx.loan_number as string) ?? null,
      description: (tx.check_description as string) ?? null,
      assigned_by: (tx.assigned_by as string) ?? null,
      assigned_at: (tx.updated_at as string) ?? null,
    });
    fams.set(key, f);
  }

  /*
   * Las desincronizadas. Se piden aparte porque la pregunta es otra: no "que
   * diria la regla" sino "coincide la fila con su propio split".
   */
  const desync: DesyncRow[] = [];
  {
    type S = { assign_value: string; cost_center_id: string; percentage: number };
    const porTx = new Map<string, S[]>();
    for (let off = 0; ; off += 1000) {
      const { data } = await sb
        .from("cc_allocation_splits")
        .select("assign_value,cost_center_id,percentage")
        .eq("assign_type", "transaction")
        .order("assign_value", { ascending: true })
        .range(off, off + 999);
      if (!data?.length) break;
      for (const r of data as unknown as S[]) {
        const a = porTx.get(r.assign_value) ?? [];
        a.push(r);
        porTx.set(r.assign_value, a);
      }
      if (data.length < 1000) break;
    }
    /* Destino unico: ver la nota del tipo. */
    const unicos = [...porTx.entries()]
      .filter(([, a]) => a.length === 1 && Number(a[0].percentage) === 100)
      .map(([txId, a]) => [txId, a[0].cost_center_id] as const);

    for (let i = 0; i < unicos.length; i += 200) {
      const trozo = unicos.slice(i, i + 200);
      const { data } = await sb
        .from("pl_transactions")
        .select("id,branch,gl_code,month,year,movement,loan_number,cost_center_id")
        .in("id", trozo.map(([id]) => id));
      const cecoDelSplit = new Map(trozo);
      for (const t of (data ?? []) as unknown as Record<string, unknown>[]) {
        const suyo = t.cost_center_id as string | null;
        const delSplit = cecoDelSplit.get(t.id as string);
        if (!suyo || !delSplit || suyo === delSplit) continue;
        desync.push({
          id: t.id as string,
          branch: (t.branch as string) ?? null,
          gl_code: (t.gl_code as string) ?? null,
          month: (t.month as string) ?? null,
          year: (t.year as number) ?? null,
          movement: Number(t.movement ?? 0),
          loan_number: (t.loan_number as string) ?? null,
          rowCc: nombre(suyo),
          splitCc: nombre(delSplit),
        });
      }
    }
  }

  const families = [...fams.values()].sort((a, b) => b.rows - a.rows);
  for (const f of families) { f.accounts.sort(); f.branches.sort(); }

  const res: ManualVsRuleResult = {
    families,
    totals: {
      rows: families.reduce((s, f) => s + f.rows, 0),
      amount: families.reduce((s, f) => s + f.amount, 0),
    },
    ruleSilent: { rows: silentRows, amount: silentAmount },
    manualTotal: filas.length,
    withTrail,
    desync,
  };
  return NextResponse.json(res);
}
