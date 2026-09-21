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
  "loan_number_incomplete,cost_center_id,cost_center_status,assigned_by,assigned_at";

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
  /** Quien y cuando, cuando consta. Null en todo lo anterior al rastro. */
  assigned_by: string | null;
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

export interface ManualVsRuleResult {
  families: ManualVsRuleFamily[];
  totals: { rows: number; amount: number };
  /** Manuales donde la regla no opina. No son desacuerdo; se cuentan y ya. */
  ruleSilent: { rows: number; amount: number };
  manualTotal: number;
  /** Cuantas de las listadas tienen autor y fecha. Hoy, casi ninguna. */
  withTrail: number;
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
      assigned_at: (tx.assigned_at as string) ?? null,
    });
    fams.set(key, f);
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
  };
  return NextResponse.json(res);
}
