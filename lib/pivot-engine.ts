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

export interface TxLeaf {
  id: string;
  month: string;
  mvmt: number;
  desc: string | null;
  vendor: string | null;
  debit: number;
  credit: number;
}

export interface PivotNode {
  key: string;
  label: string;
  sortKey: number | string;
  field: string; // PivotField | "__flat__"
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
  txs: ExpandedTx[];
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
    case "description": {
      const v = tx.check_description?.trim() || "(No Description)";
      return { key: v, label: v, sortKey: v };
    }
    case "check_desc_2": {
      const v = tx.check_description_2?.trim() || "(No Description 2)";
      return { key: v, label: v, sortKey: v };
    }
    case "check_desc_3": {
      const v = tx.check_description_3?.trim() || "(No Description 3)";
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
    month: tx.month ?? "Unknown",
    mvmt: tx.movement ?? 0,
    desc: tx.check_description,
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

export function buildDynamicPivot(txs: ExpandedTx[], levels: PivotField[]): PivotNode[] {
  if (levels.length === 0) {
    return [{
      key: "__flat__",
      label: "",
      sortKey: 0,
      field: "__flat__",
      ...computeTotals(txs),
      children: [],
      txLeaves: txs.map(toLeaf),
    }];
  }

  const [field, ...rest] = levels;
  const slotMap = new Map<string, GroupSlot>();

  // Always pre-seed both Op/NonOp groups so they render even when empty
  if (field === "op_nonop") {
    slotMap.set("Operational",     { key: "Operational",     label: "Operational",     sortKey: 0, txs: [] });
    slotMap.set("Non-Operational", { key: "Non-Operational", label: "Non-Operational", sortKey: 1, txs: [] });
  }

  for (const tx of txs) {
    const g = getGroup(tx, field);
    if (!slotMap.has(g.key)) {
      slotMap.set(g.key, { key: g.key, label: g.label, sortKey: g.sortKey, txs: [] });
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
    nodes.push({
      key:      slot.key,
      label:    slot.label,
      sortKey:  slot.sortKey,
      field,
      byMonth,
      total,
      children: rest.length > 0 ? buildDynamicPivot(slot.txs, rest) : [],
      txLeaves: rest.length === 0 ? slot.txs.map(toLeaf) : [],
    });
  }

  return sortNodes(nodes);
}
