import { DESC_DIMENSIONS, descGroupOfLeaf, type TxLeaf } from "@/lib/pivot-engine";
import {
  TREND_COMPRESSION_MIN,
  type BreakdownRow,
  type DescriptionBreakdown,
} from "@/lib/cell-ref";
import type { NoteLevel, NoteScope } from "@/lib/note-scope";

const MONTH_ORDER = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

/**
 * The level below the deepest cell of the tree, grouped by each of the three
 * descriptions.
 *
 * Built from the cell's own leaves — rows already prorated by the cost-centre
 * split and already expanded for op/non-op — so every figure here adds up to
 * the cell above it. Asking the server instead answers from the raw assignment,
 * and the two do not reconcile: measured on CC01 in June, 7 of 18 GL cells.
 *
 * Lives in lib and not in the component that calls it because it is data logic,
 * and data logic inside a .tsx file can only be exercised by mounting React.
 * This branch has already produced one bug of exactly that shape — a view
 * switch whose value was frozen at mount — which every verification missed
 * because they all called the engine directly and skipped the path a person
 * walks.
 */
export function describeLeaves(
  leaves: readonly TxLeaf[],
  /** Scope of the cell, without the period. */
  scope: NoteScope,
  /** The month of the cell, or null on the Total column. */
  month: string | null,
): DescriptionBreakdown[] {
  const withMonth = (s: NoteScope): NoteScope => (month ? { ...s, month } : s);

  return DESC_DIMENSIONS.map((dim) => {
    const mine = month ? leaves.filter((l) => l.month === month) : leaves;
    type Agg = {
      key: string; label: string; total: number; count: number;
      byMonth: Record<string, number>; counts: Record<string, number>;
    };
    const g = new Map<string, Agg>();
    let populated = 0;
    for (const leaf of mine) {
      const { key, label } = descGroupOfLeaf(leaf, dim);
      if (key !== dim.blankKey) populated++;
      let e = g.get(key);
      if (!e) { e = { key, label, total: 0, count: 0, byMonth: {}, counts: {} }; g.set(key, e); }
      e.total += leaf.mvmt;
      e.count++;
      e.byMonth[leaf.month] = (e.byMonth[leaf.month] ?? 0) + leaf.mvmt;
      e.counts[leaf.month]  = (e.counts[leaf.month] ?? 0) + 1;
    }
    // Largest first: with hundreds of descriptions the reader should meet the
    // ones that move the figure without scrolling for them.
    const aggs = [...g.values()].sort((a, b) => Math.abs(b.total) - Math.abs(a.total));

    /** Anchored to the description across every month — no month in scope. */
    const rows: BreakdownRow[] = aggs.map((r) => ({
      level:      dim.field as NoteLevel,
      levelLabel: dim.label,
      valueLabel: r.label,
      key:        r.key,
      scope:      withMonth({ ...scope, [dim.field]: r.key }),
      amount:     r.total,
      count:      r.count,
      byMonth:    r.byMonth,
    }));

    /**
     * One row per description and month — the list view, and the cells of the
     * matrix. One array serving both is what makes a note written in either
     * view appear in the other: they are not two constructions that have to
     * agree, they are the same scopes rendered twice.
     *
     * Only on the Total column; in a month cell the rows above already are this.
     */
    const perMonth: BreakdownRow[] | null = month ? null : aggs.flatMap((r) =>
      MONTH_ORDER.filter((m) => r.byMonth[m] !== undefined).map((m) => ({
        level:      dim.field as NoteLevel,
        levelLabel: dim.label,
        valueLabel: r.label,
        key:        r.key,
        month:      m,
        scope:      { ...scope, [dim.field]: r.key, month: m },
        amount:     r.byMonth[m],
        count:      r.counts[m],
      })),
    );

    // The blank bucket is left out of the ratio on both sides: the absence of a
    // description is not a description that repeats.
    const real        = aggs.filter((r) => r.key !== dim.blankKey);
    const listRows    = real.reduce((s, r) => s + Object.keys(r.byMonth).length, 0);
    const compression = month || !real.length ? null : listRows / real.length;

    return {
      level: dim.field as NoteLevel,
      label: dim.label,
      populated,
      rows,
      perMonth,
      compression,
      suggestedMode: compression == null
        ? null
        : compression >= TREND_COMPRESSION_MIN ? ("trend" as const) : ("byMonth" as const),
    };
  });
}
