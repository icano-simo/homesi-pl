import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

type ValType = "b2b" | "on_demand" | "processing" | "all_loans" | "recruitment";

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
}

export interface SurplusRow {
  loan_number: string | null;
  check_description: string | null;
  movement: number;
  month: string | null;
  year: number | null;
  branch: string | null;
  incomplete: boolean;
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
  if (branches.length > 0) loQuery = loQuery.in("branch", branches);

  if (type === "b2b") loQuery = loQuery.eq("b2b", true);
  else if (type === "on_demand") loQuery = loQuery.eq("support_on_demand", true);
  else if (type === "processing") loQuery = loQuery.eq("processing", true);
  else if (type === "recruitment") loQuery = loQuery.eq("recruitment", true);
  // all_loans: no flag filter

  const { data: loanOfficials, error: loError } = await loQuery;
  if (loError) return NextResponse.json({ error: loError.message }, { status: 500 });

  // ── 2. Determine GL code and description filter ─────────────────────────────
  const glCode =
    type === "b2b" || type === "all_loans" || type === "recruitment" ? "41309" :
    type === "on_demand" ? "41205" : "55275";
  const descFilter =
    type === "on_demand" ? "LOA ON DEMAND FEE ON FILE" :
    type === "processing" ? "PROCESSING FEE ON FILE" : null;

  // ── 3. Fetch pl_transactions for this GL code (same period, no branch filter) ─
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let txQuery: any = supabase
    .from("pl_transactions")
    .select("loan_number, loan_number_incomplete, check_description, movement, month, year, branch")
    .eq("gl_code", glCode);

  if (months.length > 0) txQuery = txQuery.in("month", months);
  if (years.length > 0) txQuery = txQuery.in("year", years);
  if (descFilter) txQuery = txQuery.ilike("check_description", `%${descFilter}%`);

  const { data: transactions, error: txError } = await txQuery;
  if (txError) return NextResponse.json({ error: txError.message }, { status: 500 });

  // ── 4. Aggregate transactions by loan_number ────────────────────────────────
  const txByLoan = new Map<string, number>();
  for (const tx of (transactions ?? []) as Array<Record<string, unknown>>) {
    const loanNum = (tx.loan_number as string | null)?.trim();
    if (!loanNum || tx.loan_number_incomplete) continue;
    txByLoan.set(loanNum, (txByLoan.get(loanNum) ?? 0) + ((tx.movement as number) ?? 0));
  }

  // Set of loan_numbers from the filtered loan_officials
  const loSet = new Set<string>(
    (loanOfficials ?? []).map((lo: Record<string, unknown>) => lo.loan_number as string)
  );

  // ── 5. Build validation rows (one per loan in loan_officials) ───────────────
  const showBps = type === "b2b" || type === "all_loans" || type === "recruitment";
  const rows: ValidationRow[] = (loanOfficials ?? []).map((lo: Record<string, unknown>) => {
    const loanNum = lo.loan_number as string;
    const total = txByLoan.get(loanNum);
    const accounting_total = total ?? 0;
    const loan_amount = lo.loan_amount as number | null;
    const bps =
      showBps && total !== undefined && loan_amount
        ? (accounting_total / loan_amount) * 10000
        : null;
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
        movement: (tx.movement as number) ?? 0,
        month: tx.month as string | null,
        year: tx.year as number | null,
        branch: tx.branch as string | null,
        incomplete,
      });
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
