import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { isB2BFeeExempt, resolveLoanBranchAlias } from "@/lib/loan-branch";
import { MARGIN_RECEIVED_GL_CODES, MARGIN_RECEIVED_GL_LIST } from "@/lib/loan-detail-accounts";

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
  /**
   * How the loan came in: "Banked - Retail" or "Brokered".
   *
   * A constant in the All Loans list, which filters to banked before this is
   * built, and genuinely varying in B2B — 96 banked against 10 brokered. So the
   * value travels for both and only B2B offers it as a filter: a filter with
   * one option is a control that cannot do anything.
   */
  loan_info_channel: string | null;
  month: string | null;
  year: number | null;
  loan_amount: number | null;
  /** DM Margin (41309) only — never DM + RM. See rm_total. */
  accounting_total: number;
  /**
   * The same DM figure, null when there is no DM booking at all.
   *
   * accounting_total collapses "no booking" and "a booking of zero" into 0, and
   * that was harmless while a loan could only match through DM. It is not
   * harmless now: the 15 loans that match through RM alone would print 0,00
   * under DM Margin, which reads as a fee booked at zero rather than a fee not
   * booked there. The field stays for the callers that only want a number.
   */
  dm_total: number | null;
  /**
   * RM Margin (41307), the alternative booking of the same corporate fee.
   *
   * Null means no RM booking at all, which is not the same as a booking of
   * zero. Its own field because 27 loans carry both accounts and 15 carry only
   * this one: adding them would make the DM column and its bps into something
   * other than what they are labelled.
   */
  rm_total: number | null;
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
    .select("loan_number, borrower_name, loan_officer, branch, loan_amount, month, year, loan_program, loan_info_channel")
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
  //
  // Filtered on the prefix, in JS, through the one predicate that owns the
  // rule — see isBankedChannel. The `= "Banked - Retail"` this replaces agreed
  // with the loan detail's own test only because a single banked value exists
  // today; a second one would have entered one screen and not the other.
  if (type === "all_loans") loQuery = loQuery.like("loan_info_channel", "Banked%");

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
  //
  // all_loans: match by the margin GL codes — DM Margin (41309) OR RM Margin
  // (41307). It was 41309 alone, which reported 15 loans as missing their
  // margin when they had received it in RM: 45 alerts of which only 30 were
  // real. See MARGIN_RECEIVED_GL_CODES for why this is a different definition
  // of "margin" from the five accounts the Table List net uses, and why the two
  // must not be unified.
  const glCodes: readonly string[] | null = type === "all_loans" ? MARGIN_RECEIVED_GL_LIST : null;
  const descFilter: string | null = type === "b2b" ? "B2B SUCCESS FEE" : null;

  // ── 3. Fetch pl_transactions matching the period + branch filter ─────────────
  // Paginate to avoid Supabase's default 1000-row cap.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buildTxQuery = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = supabase
      .from("pl_transactions")
      .select("loan_number, loan_number_incomplete, check_description, gl_code, movement, month, year, branch");
    if (glCodes)         q = q.in("gl_code", glCodes as string[]);
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
  /**
   * RM Margin kept apart, never added to DM.
   *
   * They are alternative bookings of the same corporate fee, not two components
   * of one figure, and 27 of the 388 loans carry both. Summed, the "DM Margin"
   * column would silently stop being DM Margin and its bps would stop being the
   * fee rate it is read as. So each keeps its own column and the check only asks
   * whether either exists.
   */
  const rmByLoan = new Map<string, number>();
  for (const tx of (transactions ?? []) as Array<Record<string, unknown>>) {
    const loanNum = (tx.loan_number as string | null)?.trim();
    if (!loanNum || tx.loan_number_incomplete) continue;
    if (tx.gl_code === MARGIN_RECEIVED_GL_CODES.rm) {
      rmByLoan.set(loanNum, (rmByLoan.get(loanNum) ?? 0) + ((tx.movement as number) ?? 0));
    } else {
      txByLoan.set(loanNum, (txByLoan.get(loanNum) ?? 0) + ((tx.movement as number) ?? 0));
    }
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
    const rmTotal = rmByLoan.get(loanNum);
    /**
     * Margin was received if EITHER account carries it. Existence, not amount:
     * the two are never compared and never added.
     */
    const gotMargin = total !== undefined || rmTotal !== undefined;
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
      loan_info_channel: lo.loan_info_channel as string | null,
      month: lo.month as string | null,
      year: lo.year as number | null,
      loan_amount,
      accounting_total,
      dm_total: total ?? null,
      /** Null when the loan has no RM booking, so "none" and "zero" stay apart. */
      rm_total: rmTotal ?? null,
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
      status: gotMargin
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
