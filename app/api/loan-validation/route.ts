import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

type ValType = "b2b" | "on_demand" | "processing" | "all_loans";

export interface ValidationRow {
  loan_number: string;
  borrower_name: string | null;
  loan_officer: string | null;
  branch: string | null;
  month: string | null;
  year: number | null;
  loan_amount: number | null;
  accounting_total: number;
  bps: number | null;
  status: "match" | "missing";
  tx_description: string | null;
  tx_movement: number | null;
}

export interface SurplusRow {
  loan_number: string | null;
  check_description: string | null;
  gl_code: string | null;
  movement: number;
  month: string | null;
  year: number | null;
  branch: string | null;
  incomplete: boolean;
  borrower_name: string | null;
  loan_officer: string | null;
  loan_amount: number | null;
  surplus_reason: "loan_exists_not_flagged" | "loan_not_found" | "loan_number_unresolved" | null;
}

export interface ValidationResult {
  rows: ValidationRow[];
  surplus: SurplusRow[];
  summary: {
    match_count: number;
    missing_count: number;
    surplus_count: number;
  };
}

export async function GET(req: NextRequest) {
  const supabase = createServerClient();
  const { searchParams } = new URL(req.url);

  const type = (searchParams.get("type") ?? "b2b") as ValType;
  const months = searchParams.getAll("month");
  const years = searchParams.getAll("year").map(Number).filter((n) => !isNaN(n));
  const branches = searchParams.getAll("branch");

  // ── 1. Fetch loan_officials with the appropriate flag filter ────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let loQuery: any = supabase
    .from("loan_officials")
    .select("loan_number, borrower_name, loan_officer, branch, loan_amount, month, year")
    .order("loan_number");

  if (months.length > 0) loQuery = loQuery.in("month", months);
  if (years.length > 0) loQuery = loQuery.in("year", years);
  // branch filter intentionally NOT applied to loan_officials — the master loan list
  // is always the full universe; branch only restricts the accounting-side transactions.

  if (type === "b2b") loQuery = loQuery.eq("b2b", true);
  else if (type === "on_demand") loQuery = loQuery.eq("support_on_demand", true);
  else if (type === "processing") loQuery = loQuery.eq("processing", true);
  // all_loans: no flag filter

  const { data: loanOfficials, error: loError } = await loQuery;
  if (loError) return NextResponse.json({ error: loError.message }, { status: 500 });

  // ── 2. Determine transaction filter strategy ───────────────────────────────
  // B2B, On Demand, Processing: match by check_description text regardless of GL code.
  // Recruitment and all_loans: match by GL code 41309 (description text TBD for recruitment).
  const glCode: string | null = type === "all_loans" ? "41309" : null;
  const descFilter: string | null =
    type === "b2b"        ? "B2B SUCCESS FEE" :
    type === "on_demand"  ? "LOA ON DEMAND FEE" :
    type === "processing" ? "PROCESSING FEE ON FILE" : null;

  // ── 3. Fetch pl_transactions matching the period + branch filter ─────────────
  // Paginate to avoid Supabase's default 1000-row cap.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buildTxQuery = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = supabase
      .from("pl_transactions")
      .select("loan_number, loan_number_incomplete, check_description, gl_code, movement, month, year, branch");
    if (glCode)          q = q.eq("gl_code", glCode);
    if (descFilter)      q = q.ilike("check_description", `%${descFilter}%`);
    if (months.length  > 0) q = q.in("month",  months);
    if (years.length   > 0) q = q.in("year",   years);
    if (branches.length > 0) q = q.in("branch", branches);
    return q;
  };

  const transactions: Array<Record<string, unknown>> = [];
  let txOffset = 0;
  while (true) {
    const { data: txPage, error: txError } = await buildTxQuery().range(txOffset, txOffset + 999);
    if (txError) return NextResponse.json({ error: txError.message }, { status: 500 });
    if (!txPage || txPage.length === 0) break;
    transactions.push(...(txPage as Array<Record<string, unknown>>));
    if (txPage.length < 1000) break;
    txOffset += 1000;
  }

  // ── 4. Aggregate transactions by loan_number ────────────────────────────────
  const txByLoan = new Map<string, number>();
  for (const tx of (transactions ?? []) as Array<Record<string, unknown>>) {
    const loanNum = (tx.loan_number as string | null)?.trim();
    if (!loanNum || tx.loan_number_incomplete) continue;
    txByLoan.set(loanNum, (txByLoan.get(loanNum) ?? 0) + ((tx.movement as number) ?? 0));
  }

  // ── 4b. Branch-700 aggregation for B2B description / movement columns ─────────
  const txB700ByLoan = new Map<string, { movement: number; description: string | null }>();
  if (type === "b2b") {
    for (const tx of (transactions ?? []) as Array<Record<string, unknown>>) {
      const loanNum = (tx.loan_number as string | null)?.trim();
      if (!loanNum || (tx.loan_number_incomplete as boolean) || (tx.branch as string) !== "700") continue;
      const existing = txB700ByLoan.get(loanNum);
      if (existing) {
        existing.movement += (tx.movement as number) ?? 0;
      } else {
        txB700ByLoan.set(loanNum, {
          movement: (tx.movement as number) ?? 0,
          description: tx.check_description as string | null,
        });
      }
    }
  }

  // Set of loan_numbers from the filtered loan_officials
  const loSet = new Set<string>(
    (loanOfficials ?? []).map((lo: Record<string, unknown>) => lo.loan_number as string)
  );

  // ── 5. Build validation rows (one per loan in loan_officials) ───────────────
  const showBps = type === "all_loans";
  const rows: ValidationRow[] = (loanOfficials ?? []).map((lo: Record<string, unknown>) => {
    const loanNum = lo.loan_number as string;
    const total = txByLoan.get(loanNum);
    const accounting_total = total ?? 0;
    const loan_amount = lo.loan_amount as number | null;
    const bps =
      showBps && total !== undefined && loan_amount
        ? (accounting_total / loan_amount) * 10000
        : null;
    const b700 = txB700ByLoan.get(loanNum);
    return {
      loan_number: loanNum,
      borrower_name: lo.borrower_name as string | null,
      loan_officer: lo.loan_officer as string | null,
      branch: lo.branch as string | null,
      month: lo.month as string | null,
      year: lo.year as number | null,
      loan_amount,
      accounting_total,
      bps,
      status: total !== undefined ? "match" : "missing",
      tx_description: b700?.description ?? null,
      tx_movement: b700 != null ? b700.movement : null,
    };
  });

  // ── 6. Find surplus: transactions whose loan_number is not in our loan set ──
  const surplus: SurplusRow[] = [];
  for (const tx of (transactions ?? []) as Array<Record<string, unknown>>) {
    const loanNum = (tx.loan_number as string | null)?.trim() ?? null;
    const incomplete = (tx.loan_number_incomplete as boolean) ?? false;
    // Incomplete loan numbers can't be reliably matched — always surplus
    if (incomplete || !loanNum || !loSet.has(loanNum)) {
      surplus.push({
        loan_number: loanNum,
        check_description: tx.check_description as string | null,
        gl_code: tx.gl_code as string | null,
        movement: (tx.movement as number) ?? 0,
        month: tx.month as string | null,
        year: tx.year as number | null,
        branch: tx.branch as string | null,
        incomplete,
        borrower_name: null,
        loan_officer: null,
        loan_amount: null,
        surplus_reason: null,
      });
    }
  }

  // ── 7. Enrich surplus for flagged types ─────────────────────────────────────
  if (type !== "all_loans" && surplus.length > 0) {
    const completeLns = [
      ...new Set(
        surplus
          .filter((s) => s.loan_number && !s.incomplete)
          .map((s) => s.loan_number as string)
      ),
    ];

    const enrichMap = new Map<
      string,
      { borrower_name: string | null; loan_officer: string | null; branch: string | null; loan_amount: number | null }
    >();

    if (completeLns.length > 0) {
      const { data: enrichData } = await supabase
        .from("loan_officials")
        .select("loan_number, borrower_name, loan_officer, branch, loan_amount")
        .in("loan_number", completeLns);

      for (const row of (enrichData ?? []) as Array<Record<string, unknown>>) {
        enrichMap.set(row.loan_number as string, {
          borrower_name: row.borrower_name as string | null,
          loan_officer: row.loan_officer as string | null,
          branch: row.branch as string | null,
          loan_amount: row.loan_amount as number | null,
        });
      }
    }

    for (const s of surplus) {
      if (!s.loan_number || s.incomplete) {
        s.surplus_reason = "loan_number_unresolved";
      } else {
        const enrich = enrichMap.get(s.loan_number);
        if (enrich) {
          s.borrower_name = enrich.borrower_name;
          s.loan_officer = enrich.loan_officer;
          if (!s.branch) s.branch = enrich.branch;
          s.loan_amount = enrich.loan_amount;
          s.surplus_reason = "loan_exists_not_flagged";
        } else {
          s.surplus_reason = "loan_not_found";
        }
      }
    }
  }

  return NextResponse.json({
    rows,
    surplus,
    summary: {
      match_count: rows.filter((r) => r.status === "match").length,
      missing_count: rows.filter((r) => r.status === "missing").length,
      surplus_count: surplus.length,
    },
  } satisfies ValidationResult);
}
