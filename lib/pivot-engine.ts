import type { PLReportTx } from "@/types";

// ─── Field definitions ────────────────────────────────────────────────────────

export type PivotField =
  | "op_nonop"
  | "category_2"
  | "category_6"
  | "category_7"
  | "gl"
  | "cost_center"
  | "description"
  | "check_desc_2"
  | "check_desc_3"
  | "loan_number";

export const FIELD_LABELS: Record<PivotField, string> = {
  op_nonop:     "Operational / Non-Op",
  category_2:   "Category 2",
  category_6:   "Category 6",
  category_7:   "Category 7",
  gl:           "GL Code — GL Name",
  cost_center:  "Cost Center",
  description:  "Description",
  check_desc_2: "Description 2 (OA)",
  check_desc_3: "Description 3 (OA)",
  loan_number:  "Loan Number",
};

export const ALL_FIELDS: PivotField[] = [
  "op_nonop", "category_2", "category_6", "category_7", "gl",
  "cost_center", "description", "check_desc_2", "check_desc_3", "loan_number",
];

// ─── Tree types ───────────────────────────────────────────────────────────────

/**
 * The three description dimensions, in one place.
 *
 * Written once because two things depend on these exact strings: how the pivot
 * groups rows, and what a note anchored to a description stores in its scope.
 * A second copy anywhere — an API route grouping the same rows its own way —
 * anchors notes to cells the pivot never builds, so they exist in the table and
 * appear nowhere.
 *
 * Description 3 is the odd one: only Offshore Allocations rows carry it, so
 * everywhere else it collapses into a single dash-labelled bucket sorted last
 * rather than a wordy "(No Description 3)" heading that reads like a real
 * category. Its key is a sentinel rather than its label, so notes stay anchored
 * if the label is ever reworded.
 */
export const DESC_DIMENSIONS = [
  { field: "description",  column: "check_description",   label: "Description",
    blankKey: "(No Description)",   blankLabel: "(No Description)",   blankSort: "(No Description)" },
  { field: "check_desc_2", column: "check_description_2", label: "Description 2",
    blankKey: "(No Description 2)", blankLabel: "(No Description 2)", blankSort: "(No Description 2)" },
  { field: "check_desc_3", column: "check_description_3", label: "Description 3",
    blankKey: "__no_desc3__",       blankLabel: "—",                  blankSort: "￿" },
] as const;

export type DescDimension = (typeof DESC_DIMENSIONS)[number];

export interface TxLeaf {
  /** Render key. Composite — a transaction fanned across cost centers or split
   *  Operational/Non-Operational produces several leaves sharing one txId. */
  id: string;
  /** The real pl_transactions UUID. Use this, never `id`, to anchor a note. */
  txId: string;
  month: string;
  mvmt: number;
  desc: string | null;
  /** The other two descriptions, carried so the level below a GL cell can be
   *  grouped from these rows — which are the report's own rows, prorated by
   *  the cost-centre split and expanded for op/non-op — instead of from a
   *  second query against the raw assignment, which reconciles with nothing. */
  desc2: string | null;
  desc3: string | null;
  vendor: string | null;
  debit: number;
  credit: number;
}

/** Group key and label for a leaf under one of the description dimensions. */
export function descGroupOfLeaf(leaf: TxLeaf, dim: DescDimension): { key: string; label: string } {
  const raw = (dim.field === "description" ? leaf.desc
             : dim.field === "check_desc_2" ? leaf.desc2
             : leaf.desc3)?.trim();
  return raw ? { key: raw, label: raw } : { key: dim.blankKey, label: dim.blankLabel };
}

/**
 * Accumulated dimension constraints identifying a node, e.g.
 * { category_2: "Income", category_6: "Revenue" }.
 *
 * Values are *stable identifiers* (gl_code, cost_center_id), not display
 * labels, so renaming a GL or cost center does not change a node's identity.
 * Together with a month this is the anchor a note is attached to — see
 * lib/note-scope.ts. Declared structurally rather than importing NoteScope to
 * avoid a module cycle (note-scope.ts already imports PivotField from here).
 */
export type NodeScope = Record<string, string>;

export interface PivotNode {
  key: string;
  label: string;
  sortKey: number | string;
  field: string; // PivotField | "__flat__"
  /** Constraints from the root down to and including this node. */
  scope: NodeScope;
  byMonth: Record<string, number>;
  total: number;
  children: PivotNode[];
  txLeaves: TxLeaf[];
}

export type ExpandedTx = PLReportTx & {
  _opGroup?: "Operational" | "Non-Operational";
};

// ─── Op/NonOp pre-expansion ───────────────────────────────────────────────────

export function expandForOpNonOp(txs: PLReportTx[]): ExpandedTx[] {
  const out: ExpandedTx[] = [];
  for (const tx of txs) {
    const pct = tx.operational_pct ?? 100;
    if (pct > 0) {
      out.push({
        ...tx,
        movement: (tx.movement ?? 0) * pct / 100,
        debit:    tx.debit * pct / 100,
        credit:   tx.credit * pct / 100,
        _opGroup: "Operational",
      });
    }
    if (pct < 100) {
      out.push({
        ...tx,
        movement: (tx.movement ?? 0) * (100 - pct) / 100,
        debit:    tx.debit * (100 - pct) / 100,
        credit:   tx.credit * (100 - pct) / 100,
        _opGroup: "Non-Operational",
      });
    }
  }
  return out;
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function glLabel(code: string | null | undefined, name: string | null | undefined): string {
  const c = code?.trim();
  const n = name?.trim();
  if (c && n) return `${c} — ${n}`;
  return c ?? n ?? "(No GL)";
}

interface GroupSlot {
  key: string;
  label: string;
  sortKey: number | string;
  scopeValue: string;
  txs: ExpandedTx[];
}

/**
 * Stable identifier of a transaction along one dimension — the value a note is
 * anchored to. Differs from the grouping key only where the key is a display
 * label: `gl` groups by "41309 — Origination Income" but anchors to the bare
 * gl_code, and `cost_center` anchors to cost_center_id rather than its name, so
 * renaming either does not detach existing notes.
 */
export function stableScopeValue(tx: ExpandedTx, field: PivotField): string {
  switch (field) {
    case "gl":
      return tx.gl_code?.trim() || "(No GL)";
    case "cost_center": {
      const status = tx.cost_center_status;
      if (!status || status === "unassigned" || !tx.cost_center_id) return "__unassigned__";
      if (status === "conflict") return "__conflict__";
      return tx.cost_center_id;
    }
    default:
      // Every other dimension groups by a value that is already stable.
      return getGroup(tx, field).key;
  }
}

function getGroup(tx: ExpandedTx, field: PivotField): { key: string; label: string; sortKey: number | string } {
  switch (field) {
    case "op_nonop": {
      const g = tx._opGroup ?? "Operational";
      return { key: g, label: g, sortKey: g === "Operational" ? 0 : 1 };
    }
    case "category_2": {
      const v = tx.category_2?.trim() || "Uncategorized";
      return { key: v, label: v, sortKey: tx.order_1 ?? 9999 };
    }
    case "category_6": {
      const v = tx.category_6?.trim() || "(No Category 6)";
      return { key: v, label: v, sortKey: tx.order_2 ?? 9999 };
    }
    case "category_7": {
      const v = tx.category_7?.trim() || "(No Category 7)";
      return { key: v, label: v, sortKey: tx.order_3 ?? 9999 };
    }
    case "gl": {
      const v = glLabel(tx.gl_code, tx.gl_name);
      return { key: v, label: v, sortKey: v };
    }
    case "cost_center": {
      const status = tx.cost_center_status;
      if (!status || status === "unassigned" || !tx.cost_center_id) {
        return { key: "__unassigned__", label: "Unassigned", sortKey: "￿1" };
      }
      if (status === "conflict") {
        return { key: "__conflict__", label: "Conflict", sortKey: "￿2" };
      }
      const name = tx.cost_centers?.name ?? tx.cost_center_id;
      return { key: tx.cost_center_id, label: name, sortKey: name };
    }
    case "description":
    case "check_desc_2":
    case "check_desc_3": {
      const dim = DESC_DIMENSIONS.find((d) => d.field === field)!;
      const v = tx[dim.column]?.trim();
      if (!v) return { key: dim.blankKey, label: dim.blankLabel, sortKey: dim.blankSort };
      return { key: v, label: v, sortKey: v };
    }
    case "loan_number": {
      const v = tx.loan_number?.trim();
      if (!v) return { key: "__no_loan__", label: "No Loan Number", sortKey: "￿" };
      return { key: v, label: v, sortKey: v };
    }
  }
}

function computeTotals(txs: ExpandedTx[]): { byMonth: Record<string, number>; total: number } {
  const byMonth: Record<string, number> = {};
  let total = 0;
  for (const tx of txs) {
    const m = tx.movement ?? 0;
    const month = tx.month ?? "Unknown";
    byMonth[month] = (byMonth[month] ?? 0) + m;
    total += m;
  }
  return { byMonth, total };
}

function toLeaf(tx: ExpandedTx): TxLeaf {
  // Include cost_center_id so that virtual copies produced by fanOutBySplits
  // (same tx.id fanned to multiple CCs) each get a distinct leaf key.
  const base = tx.cost_center_id ? `${tx.id}:${tx.cost_center_id}` : tx.id;
  return {
    id: tx._opGroup ? `${base}::${tx._opGroup[0]}` : base,
    txId: tx.id,
    month: tx.month ?? "Unknown",
    mvmt: tx.movement ?? 0,
    desc: tx.check_description,
    desc2: tx.check_description_2 ?? null,
    desc3: tx.check_description_3 ?? null,
    vendor: tx.vendor,
    debit: tx.debit,
    credit: tx.credit,
  };
}

function sortNodes(nodes: PivotNode[]): PivotNode[] {
  return [...nodes].sort((a, b) => {
    if (typeof a.sortKey === "number" && typeof b.sortKey === "number") {
      return a.sortKey - b.sortKey;
    }
    return String(a.sortKey).localeCompare(String(b.sortKey));
  });
}

// ─── Public engine ────────────────────────────────────────────────────────────

/** Does any of these transactions carry a Description 3? */
function anyDesc3(txs: readonly ExpandedTx[]): boolean {
  return txs.some((t) => (t.check_description_3 ?? "").trim() !== "");
}

/**
 * Drops levels that would insert a node without telling the reader anything.
 *
 * Only check_desc_3 qualifies, and only for the transactions actually under the
 * node being built. Description 3 exists solely on Offshore Allocations rows —
 * 792 of 27,365 measured on 2026-08-12 — so everywhere else the level collapses
 * into a single group labelled "—" (see getGroup) that has to be expanded to
 * reach the transactions beneath it. That extra click is why transaction-level
 * notes were effectively unreachable: a user drilling down stops at
 * `description`, which already looks like an individual line, rather than
 * expanding a dash to find the real leaf rows.
 *
 * The decision is per node, not per report. A branch whose rows carry a
 * Description 3 keeps the level and its grouping; a sibling branch without one
 * hangs its transactions directly off the level above. Both can appear in the
 * same report.
 *
 * Skipping a level never changes the scope of the levels above it — a node's
 * scope is built from its own ancestors — so notes anchored higher up keep
 * their scope_key.
 */
function effectiveLevels(levels: PivotField[], txs: readonly ExpandedTx[]): PivotField[] {
  let out = levels;
  while (out.length > 0 && out[0] === "check_desc_3" && !anyDesc3(txs)) {
    out = out.slice(1);
  }
  return out;
}

export function buildDynamicPivot(
  txs: ExpandedTx[],
  requestedLevels: PivotField[],
  parentScope: NodeScope = {},
): PivotNode[] {
  const levels = effectiveLevels(requestedLevels, txs);

  if (levels.length === 0) {
    return [{
      key: "__flat__",
      label: "",
      sortKey: 0,
      field: "__flat__",
      scope: parentScope,
      ...computeTotals(txs),
      children: [],
      txLeaves: txs.map(toLeaf),
    }];
  }

  const [field, ...rest] = levels;
  const slotMap = new Map<string, GroupSlot>();

  // Always pre-seed both Op/NonOp groups so they render even when empty
  if (field === "op_nonop") {
    slotMap.set("Operational",     { key: "Operational",     label: "Operational",     sortKey: 0, scopeValue: "Operational",     txs: [] });
    slotMap.set("Non-Operational", { key: "Non-Operational", label: "Non-Operational", sortKey: 1, scopeValue: "Non-Operational", txs: [] });
  }

  for (const tx of txs) {
    const g = getGroup(tx, field);
    if (!slotMap.has(g.key)) {
      slotMap.set(g.key, {
        key: g.key,
        label: g.label,
        sortKey: g.sortKey,
        scopeValue: stableScopeValue(tx, field),
        txs: [],
      });
    } else if (field !== "op_nonop") {
      // Track minimum order value so groups sort stably when multiple txs appear
      const slot = slotMap.get(g.key)!;
      if (typeof g.sortKey === "number" && typeof slot.sortKey === "number" && g.sortKey < slot.sortKey) {
        slot.sortKey = g.sortKey;
      }
    }
    slotMap.get(g.key)!.txs.push(tx);
  }

  const nodes: PivotNode[] = [];
  for (const slot of slotMap.values()) {
    const { byMonth, total } = computeTotals(slot.txs);
    const scope: NodeScope = { ...parentScope, [field]: slot.scopeValue };
    // Resolved per slot, so the node knows whether its own rows still need a
    // deeper level or should carry the transactions themselves. Without this the
    // skipped level would come back as a nested "__flat__" child, which the
    // renderer draws flush left instead of indented under its parent.
    const childLevels = effectiveLevels(rest, slot.txs);
    nodes.push({
      key:      slot.key,
      label:    slot.label,
      sortKey:  slot.sortKey,
      field,
      scope,
      byMonth,
      total,
      children: childLevels.length > 0 ? buildDynamicPivot(slot.txs, childLevels, scope) : [],
      txLeaves: childLevels.length === 0 ? slot.txs.map(toLeaf) : [],
    });
  }

  return sortNodes(nodes);
}
