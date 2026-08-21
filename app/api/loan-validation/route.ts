import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { isB2BFeeExempt, resolveLoanBranchAlias } from "@/lib/loan-branch";

export const dynamic = "force-dynamic";

// On Demand and Processing were retired from the UI; the type keeps only what
// is reachable.
type ValType = "b2b" | "all_loans";

export interface ValidationRow {
  loan_number: string;
  borrower_name: string | null;
  loan_officer: string | null;
  branch: string | null;
  loan_program: string | null;
  month: string | null;
  year: number | null;
  loan_amount: number | null;
  accounting_total: number;
  bps: number | null;
  status: "match" | "missing" | "exempt";
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
    /** Fee absent on a branch that does not pay it. Not a finding. */
    exempt_count: number;
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
  /** Only the tallies, for the roadmap — see the early return at the end. */
  const summaryOnly = searchParams.get("summary") === "1";

  // ── 1. Fetch loan_officials with the appropriate flag filter ────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let loQuery: any = supabase
    .from("loan_officials")
    .select("loan_number, borrower_name, loan_officer, branch, loan_amount, month, year, loan_program")
    .order("loan_number");

  if (months.length > 0) loQuery = loQuery.in("month", months);
  if (years.length > 0) loQuery = loQuery.in("year", years);
  /**
   * The branch filter narrows the MASTER LIST — the branch that produced the
   * loan — and no longer the accounting side. Applied in JS just below, not
   * here, because the value has to pass through resolveLoanBranchAlias first:
   * "Affinity" and 716 are one branch, and a SQL `in` on the raw column would
   * answer for only half of it.
   *
   * It used to be the other way round, and that made the screen useless the
   * moment a branch was picked. The margin of nearly every loan is booked in
   * the corporate branch 700, so restricting the ACCOUNTING side by branch left
   * five of eight branches with zero rows against the whole master, and every
   * loan read as "missing in accounting".
   */

  if (type === "b2b") loQuery = loQuery.eq("b2b", true);
  // all_loans: no flag filter.
  //
  // Brokered loans are dropped from it: they do not earn margin the way banked
  // loans do, so listing them as "missing in accounting" reports an absence
  // that was never going to be there. Measured 2026-08-17: 48 brokered of 436.
  if (type === "all_loans") loQuery = loQuery.eq("loan_info_channel", "Banked - Retail");

  const { data: loanOfficialsAll, error: loError } = await loQuery;
  if (loError) return NextResponse.json({ error: loError.message }, { status: 500 });

  /**
   * The loans this screen is about: the master list of the period, narrowed to
   * the branches that PRODUCED them, with "Affinity" resolved to 716 by the one
   * function that owns that rule.
   */
  const loanOfficials = branches.length > 0
    ? (loanOfficialsAll ?? []).filter((lo: Record<string, unknown>) => {
        const b = resolveLoanBranchAlias(lo.branch as string | null);
        return b !== null && branches.includes(b);
      })
    : (loanOfficialsAll ?? []);

  // ── 2. Determine transaction filter strategy ───────────────────────────────
  // B2B, On Demand, Processing: match by check_description text regardless of GL code.
  // Recruitment and all_loans: match by GL code 41309 (description text TBD for recruitment).
  const glCode: string | null = type === "all_loans" ? "41309" : null;
  const descFilter: string | null = type === "b2b" ? "B2B SUCCESS FEE" : null;

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
    // No branch filter. A loan's fee is matched by loan_number wherever it was
    // booked — which is the whole point of the change above, and the same rule
    // /api/loan-detail already follows: the branch of the LOAN and the branch
    // of the TRANSACTION are different questions.
    return q;
  };

  const transactions: Array<Record<string, unknown>> = [];
  let txOffset = 0;
  while (true) {
    const { data: txPage, error: txError } = await buildTxQuery().order("id", { ascending: true }).range(txOffset, txOffset + 999);
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

  /**
   * Surplus is judged against the WHOLE master of the period, not against the
   * branch-filtered list.
   *
   * "A fee that belongs to no loan we know of" is the useful signal. "A fee that
   * belongs to a loan of another branch" is not — with a branch picked, judging
   * against the narrowed list would turn every other branch's fee into a
   * finding and bury the real ones.
   */
  const loSet = new Set<string>(
    (loanOfficialsAll ?? []).map((lo: Record<string, unknown>) => lo.loan_number as string)
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
      // Resolved, so this screen and Loan Count name the same branch the same
      // way. The value in the file stays available in loan_officials.
      branch: resolveLoanBranchAlias(lo.branch as string | null),
      loan_program: lo.loan_program as string | null,
      month: lo.month as string | null,
      year: lo.year as number | null,
      loan_amount,
      accounting_total,
      bps,
      /**
       * Exempt is not a third kind of absence — it is the same absence, on a
       * branch that does not pay the fee. 733 and 776 do not owe the B2B
       * success fee, so no fee found there is correct and must not read as a
       * finding; the validation exists to catch the branches that are charged
       * and came back empty.
       *
       * Nothing about the detection changes. The check that already ran is the
       * one that ran; this only decides how its answer is presented.
       */
      status: total !== undefined
        ? "match"
        : (type === "b2b" && isB2BFeeExempt(lo.branch as string | null)) ? "exempt" : "missing",
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

  const summary = {
    match_count: rows.filter((r) => r.status === "match").length,
    missing_count: rows.filter((r) => r.status === "missing").length,
    exempt_count: rows.filter((r) => r.status === "exempt").length,
    surplus_count: surplus.length,
  };

  // The same tallies this endpoint already computes, without the rows and the
  // surplus list that make the response heavy. A landing page needs the number
  // and nothing else — and it has to be THIS number, not a second count of the
  // same thing.
  if (summaryOnly) return NextResponse.json({ rows: [], surplus: [], summary } satisfies ValidationResult);

  return NextResponse.json({ rows, surplus, summary } satisfies ValidationResult);
}
