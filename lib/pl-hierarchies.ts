import type { PivotField } from "@/lib/pivot-engine";

/**
 * The P&L hierarchies. Two shapes, an Operational/Non-Operational switch, and
 * nothing else.
 *
 * WHY FIXED. A reorderable pivot let the same note surface on a
 * differently-shaped row from one session to the next — and because the chosen
 * order was persisted per browser, two people could be looking at the same note
 * on different rows at the same time. That is the entire reason notes used to
 * live on their own page. With four named shapes there is nothing to reorder,
 * so the reason is gone and the two pages become one.
 *
 * Note identity never depended on the order: canonicalScopeKey sorts its keys
 * alphabetically, so a note anchored under one arrangement is found under any
 * other. What moved was the row it appeared on, not the note.
 *
 * WHERE OP/NON-OP SITS. In Regular it is the outermost split, because without a
 * cost center there is nothing above it. In Cost Center it goes immediately
 * below the centre: the question is "how does THIS centre split between
 * operational and not", and putting it on top would answer a question nobody
 * asked and scatter every centre across two branches.
 *
 * WHY IT ENDS AT gl. Below GL the useful breakdown is by description, and which
 * description carries the information depends on the account: measured on
 * production, check_description covers everything except Office Expense, where
 * it is empty on 792 of 835 rows and the content lives in check_description_2
 * and _3. One fixed level cannot serve both, so the breakdown moved into a
 * modal where the reader picks.
 *
 * category_2 is deliberately absent. It only ever held two values —
 * "Operating Income (Loss) Before BM Payroll" and "BM Payroll-Paid" — so as a
 * level it split the report in two without telling the reader much. It stays in
 * the data model and in the Cost Center summary report, which groups by it.
 */

export type HierarchyShape = "regular" | "cost_center";

export interface HierarchyChoice {
  shape: HierarchyShape;
  /** Split every branch by Operational / Non-Operational. */
  opNonOp: boolean;
}

export const SHAPE_LABELS: Record<HierarchyShape, string> = {
  regular:     "Regular",
  cost_center: "Cost Center",
};

/**
 * The levels for a choice. The only place the four combinations are written
 * down, so a fifth cannot appear by accident somewhere else.
 */
export function hierarchyLevels({ shape, opNonOp }: HierarchyChoice): PivotField[] {
  const tail: PivotField[] = ["category_6", "category_7", "gl"];

  if (shape === "cost_center") {
    return opNonOp
      ? ["cost_center", "op_nonop", ...tail]
      : ["cost_center", ...tail];
  }
  return opNonOp ? ["op_nonop", ...tail] : tail;
}

/** Human name of the current view, for the header and for a screenshot. */
export function hierarchyLabel(choice: HierarchyChoice): string {
  return choice.opNonOp
    ? `${SHAPE_LABELS[choice.shape]} · Op/Non-Op`
    : SHAPE_LABELS[choice.shape];
}
