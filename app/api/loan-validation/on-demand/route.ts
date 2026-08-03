import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export interface OnDemandAccountingItem {
  description: string;
  tx_count: number;
  net_movement: number;
}

export interface OnDemandOfficialLoan {
  loan_number: string;
  borrower_name: string | null;
  loan_officer: string | null;
  loan_amount: number | null;
}

export interface OnDemandBranchRow {
  branch: string;
  accounting_count: number;
  official_count: number;
  difference: number;
  accounting_items: OnDemandAccountingItem[];
  official_loans: OnDemandOfficialLoan[];
}

export interface OnDemandResult {
  branches: OnDemandBranchRow[];
}

export async function GET(req: NextRequest) {
  const supabase = createServerClient();
  const { searchParams } = new URL(req.url);
  const months = searchParams.getAll("month");
  const years  = searchParams.getAll("year").map(Number).filter((n) => !isNaN(n));

  // ── 1. Fetch LOA ON DEMAND FEE transactions — exclude branch 700 ─────────────
  // Branch 700 holds the central accounting contra-entries; the real per-branch
  // transactions live in branches 707, 716, 724, etc. and carry the correct branch.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buildTxQuery = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = supabase
      .from("pl_transactions")
      .select("branch, check_description, movement")
      .ilike("check_description", "%LOA ON DEMAND FEE%")
      .neq("branch", "700");
    if (months.length > 0) q = q.in("month", months);
    if (years.length  > 0) q = q.in("year",  years);
    return q;
  };

  const txRows: Array<{ branch: string | null; check_description: string | null; movement: number | null }> = [];
  let txOffset = 0;
  while (true) {
    const { data, error } = await buildTxQuery().order("id", { ascending: true }).range(txOffset, txOffset + 999);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;
    txRows.push(...(data as typeof txRows));
    if (data.length < 1000) break;
    txOffset += 1000;
  }

  // ── 2. Fetch loan_officials with support_on_demand = true ────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let loQuery: any = supabase
    .from("loan_officials")
    .select("branch, loan_number, borrower_name, loan_officer, loan_amount")
    .eq("support_on_demand", true);
  if (months.length > 0) loQuery = loQuery.in("month", months);
  if (years.length  > 0) loQuery = loQuery.in("year",  years);

  const { data: officials, error: loError } = await loQuery;
  if (loError) return NextResponse.json({ error: loError.message }, { status: 500 });

  // ── 3. Group transactions: branch → (description → { tx_count, net_movement }) ─
  // Uses pl_transactions.branch directly (branch 700 already excluded above).
  const txByBranch = new Map<string, Map<string, { tx_count: number; net_movement: number }>>();
  for (const tx of txRows) {
    const branch = tx.branch ?? "(No Branch)";
    const desc   = tx.check_description ?? "";
    if (!txByBranch.has(branch)) txByBranch.set(branch, new Map());
    const descMap = txByBranch.get(branch)!;
    const existing = descMap.get(desc);
    if (existing) {
      existing.tx_count     += 1;
      existing.net_movement += tx.movement ?? 0;
    } else {
      descMap.set(desc, { tx_count: 1, net_movement: tx.movement ?? 0 });
    }
  }

  // ── 4. Group loan_officials by branch ─────────────────────────────────────────
  const loByBranch = new Map<string, OnDemandOfficialLoan[]>();
  for (const lo of (officials ?? []) as Array<Record<string, unknown>>) {
    const branch = (lo.branch as string | null) ?? "(No Branch)";
    if (!loByBranch.has(branch)) loByBranch.set(branch, []);
    loByBranch.get(branch)!.push({
      loan_number:   lo.loan_number   as string,
      borrower_name: lo.borrower_name as string | null,
      loan_officer:  lo.loan_officer  as string | null,
      loan_amount:   lo.loan_amount   as number | null,
    });
  }

  // ── 5. Union all branches, sorted numerically then alphabetically ─────────────
  const allBranches = new Set([...txByBranch.keys(), ...loByBranch.keys()]);
  const branches: OnDemandBranchRow[] = [...allBranches]
    .sort((a, b) => {
      const na = parseInt(a, 10), nb = parseInt(b, 10);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a.localeCompare(b);
    })
    .map((branch) => {
      const descMap = txByBranch.get(branch) ?? new Map();
      const loans   = loByBranch.get(branch)   ?? [];
      const accounting_items: OnDemandAccountingItem[] = [...descMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([description, { tx_count, net_movement }]) => ({ description, tx_count, net_movement }));
      return {
        branch,
        accounting_count: accounting_items.length,
        official_count:   loans.length,
        difference:       accounting_items.length - loans.length,
        accounting_items,
        official_loans:   loans,
      };
    });

  return NextResponse.json({ branches } satisfies OnDemandResult);
}
