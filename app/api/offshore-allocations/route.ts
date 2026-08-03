import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

// Exact CD2 values that form their own named blocks.
// Anything else routes to "Other / Unclassified".
const EXPECTED_BLOCKS = new Set(["Roster Offshore", "Vendors COL", "Vendors US"]);
const OTHER_BLOCK_KEY = "Other / Unclassified";

export type OAGroupRow = {
  group_key: string;
  // How CC assignment targets this row (null = no assignment possible)
  assign_type: "description3" | "vendor" | null;
  check_description_3: string | null;
  vendor: string | null;
  // Present only on "other" block rows: the distinct raw CD2 values that ended up here
  raw_cd2s?: string[];
  branches: string[];
  years: number[];
  months: string[];
  category: string | null;
  position: string | null;
  branch_allocation: string | null;
  cc_labels: string[];
  tx_count: number;
  tx_count_unassigned: number;
};

export type OABlock = {
  block_key: string;
  block_type: "roster" | "vendor" | "other";
  rows: OAGroupRow[];
};

const SELECT =
  "id,month,year,branch,check_description_2,check_description_3," +
  "vendor,category,position,branch_allocation," +
  "cost_center_id,cost_center_status,cost_centers(name)";

const MONTH_ORDER = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

export async function GET(req: NextRequest) {
  const supabase = createServerClient();
  const branches = new URL(req.url).searchParams.getAll("branch");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all: any[] = [];
  let offset = 0;

  while (true) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = supabase
      .from("pl_transactions")
      .select(SELECT)
      .eq("source", "offshore_allocations")
      .order("id", { ascending: true })
      .range(offset, offset + 999);
    if (branches.length > 0) q = q.in("branch", branches);
    const { data, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < 1000) break;
    offset += 1000;
  }

  type WRow = {
    group_key: string;
    assign_type: "description3" | "vendor" | null;
    check_description_3: string | null;
    vendor: string | null;
    raw_cd2s?: Set<string>;
    branches: Set<string>;
    years: Set<number>;
    months: Set<string>;
    category: string | null;
    position: string | null;
    branch_allocation: string | null;
    cc_labels: Set<string>;
    tx_count: number;
    tx_count_unassigned: number;
  };
  type WBlock = {
    block_key: string;
    block_type: "roster" | "vendor" | "other";
    rows: Map<string, WRow>;
  };

  const blockMap = new Map<string, WBlock>();

  for (const tx of all) {
    const cd2Raw = (tx.check_description_2 ?? "")
      .replace(/[  -   　]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    // ── Route to the correct block ─────────────────────────────────────────
    const isExpected = EXPECTED_BLOCKS.has(cd2Raw);
    const blockKey  = isExpected ? cd2Raw : OTHER_BLOCK_KEY;
    const blockType: "roster" | "vendor" | "other" = isExpected
      ? (cd2Raw === "Roster Offshore" ? "roster" : "vendor")
      : "other";

    let block = blockMap.get(blockKey);
    if (!block) {
      block = { block_key: blockKey, block_type: blockType, rows: new Map() };
      blockMap.set(blockKey, block);
    }

    const cd3    = (tx.check_description_3 ?? "").trim() || null;
    const vendor = (tx.vendor ?? "").trim() || null;

    // ── Determine group key ────────────────────────────────────────────────
    let group_key: string;
    let assign_type: "description3" | "vendor" | null;

    if (blockType === "roster") {
      group_key   = cd3 ?? "(No Description 3)";
      assign_type = "description3";
    } else if (blockType === "vendor") {
      group_key   = vendor ?? "(Unknown Vendor)";
      assign_type = "vendor";
    } else {
      // "other" block: group by vendor if present, else individual tx row
      if (vendor) {
        group_key   = vendor;
        assign_type = "vendor";
      } else {
        group_key   = `__raw__${tx.id}`;
        assign_type = null;
      }
    }

    let row = block.rows.get(group_key);
    if (!row) {
      row = {
        group_key,
        assign_type,
        check_description_3: blockType === "roster" ? (cd3 ?? "(No Description 3)") : cd3,
        vendor: blockType === "vendor" ? (vendor ?? "(Unknown Vendor)") : vendor,
        ...(blockType === "other" ? { raw_cd2s: new Set<string>() } : {}),
        branches: new Set(),
        years: new Set(),
        months: new Set(),
        category: null,
        position: null,
        branch_allocation: null,
        cc_labels: new Set(),
        tx_count: 0,
        tx_count_unassigned: 0,
      };
      block.rows.set(group_key, row);
    }

    if (tx.branch) row.branches.add(tx.branch);
    if (tx.year != null) row.years.add(tx.year);
    if (tx.month) row.months.add(tx.month);
    if (!row.category && tx.category) row.category = tx.category;
    if (!row.position && tx.position) row.position = tx.position;
    if (!row.branch_allocation && tx.branch_allocation) row.branch_allocation = tx.branch_allocation;
    if (tx.cost_centers?.name) row.cc_labels.add(tx.cost_centers.name);
    if (blockType === "other" && row.raw_cd2s) {
      const label = cd2Raw || "(empty)";
      row.raw_cd2s.add(label);
    }
    row.tx_count++;
    if (!tx.cost_center_id || tx.cost_center_status === "unassigned") row.tx_count_unassigned++;
  }

  function serializeRows(wb: WBlock): OAGroupRow[] {
    return [...wb.rows.values()]
      .map((r): OAGroupRow => ({
        group_key:          r.group_key,
        assign_type:        r.assign_type,
        check_description_3: r.check_description_3,
        vendor:             r.vendor,
        ...(r.raw_cd2s ? { raw_cd2s: [...r.raw_cd2s].sort() } : {}),
        branches:           [...r.branches].sort(),
        years:              [...r.years].sort((a, b) => a - b),
        months:             MONTH_ORDER.filter((m) => r.months.has(m)),
        category:           r.category,
        position:           r.position,
        branch_allocation:  r.branch_allocation,
        cc_labels:          [...r.cc_labels].sort(),
        tx_count:           r.tx_count,
        tx_count_unassigned: r.tx_count_unassigned,
      }))
      .sort((a, b) => a.group_key.localeCompare(b.group_key));
  }

  const rosters: OABlock[] = [];
  const vendors: OABlock[] = [];
  const others:  OABlock[] = [];

  for (const wb of blockMap.values()) {
    const block: OABlock = { block_key: wb.block_key, block_type: wb.block_type, rows: serializeRows(wb) };
    if (wb.block_type === "roster") rosters.push(block);
    else if (wb.block_type === "vendor") vendors.push(block);
    else others.push(block);
  }

  rosters.sort((a, b) => a.block_key.localeCompare(b.block_key));
  vendors.sort((a, b) => a.block_key.localeCompare(b.block_key));
  // "Other / Unclassified" always last

  return NextResponse.json([...rosters, ...vendors, ...others] as OABlock[]);
}
