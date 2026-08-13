import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { normalizeLoanBranch, resolveBaseBranches } from "@/lib/loan-branch";
import {
  ALL_MARGIN_ACCOUNTS,
  NET_GROUPS,
  expectedMarginAccounts,
} from "@/lib/loan-detail-accounts";

export const dynamic = "force-dynamic";

const PAGE = 1000;
const IN_CHUNK = 500;

const money = (v: number | string | null | undefined): number => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** Basis points against the loan's own amount. Null when there is no amount. */
const bps = (v: number, amount: number): number | null =>
  amount ? (v / amount) * 10000 : null;

export interface LoanDetailRow {
  loan_number: string;
  borrower_name: string | null;
  loan_officer: string | null;
  branch: string;
  loan_program: string | null;
  loan_info_channel: string | null;
  loan_amount: number;
  b2b: boolean;
  processing: boolean;
  support_on_demand: boolean;
  /** category_7 → summed movement. Aggregated, never individual rows. */
  concepts: Record<string, number>;
  /** category_7 -> branches the amount is booked in, which is often not the
   *  loan's own branch. */
  concept_branches: Record<string, string[]>;
  /** Accounts booked in a branch that does not normally carry them. */
  unexpected_accounts: string[];
  /** Months the loan's revenue landed in, when not the loan's own month. */
  foreign_months: string[];
  revenue: number;
  costs: number;
  net: number;
  net_bps: number | null;
  /** No margin account carries an amount. The question this view answers. */
  no_margin: boolean;
}

export async function GET(req: NextRequest) {
  const supabase = createServerClient();
  const sp = new URL(req.url).searchParams;

  const month    = sp.get("month");
  const year     = Number(sp.get("year"));
  const branches = sp.getAll("branch");
  const sources  = sp.getAll("source");

  if (!month || !year) {
    return NextResponse.json({ error: "month and year are required" }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const page = async (build: () => any, order = "id"): Promise<any[]> => {
    const out: unknown[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await build()
        .order(order, { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      out.push(...data);
      if (data.length < PAGE) break;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return out as any[];
  };

  try {
    // ── The loans of this card ──────────────────────────────────────────────
    // Same scope resolution as the metrics endpoint, imported rather than
    // restated: the window must list exactly the loans the card counted,
    // corporate rule included.
    const effectiveBranches = resolveBaseBranches(branches);
    const inScope = (b: string) => !effectiveBranches || effectiveBranches.includes(b);

    const rawLoans = await page(() =>
      supabase
        .from("loan_officials")
        .select("loan_number,borrower_name,loan_officer,branch,loan_amount,loan_program,loan_info_channel,b2b,processing,support_on_demand,month,year")
        .eq("month", month)
        .eq("year", year),
    );

    const loans = rawLoans
      .map((l) => ({ ...l, branch: normalizeLoanBranch(l.branch) }))
      .filter((l) => l.branch !== null && inScope(l.branch));

    const loanNumbers = loans.map((l) => l.loan_number as string);

    // ── Everything posted against those loans ───────────────────────────────
    // Not restricted to this month: a loan's margin sometimes lands later, and
    // dropping it would show the loan as having earned nothing. The month it
    // actually landed in travels with the row so the window can say so.
    const txs: Array<{ loan_number: string; branch: string | null; category_6: string | null; category_7: string | null; movement: number | string | null; month: string | null; year: number | null }> = [];
    for (let i = 0; i < loanNumbers.length; i += IN_CHUNK) {
      const chunk = loanNumbers.slice(i, i + IN_CHUNK);
      if (chunk.length === 0) break;
      const rows = await page(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let q: any = supabase
          .from("pl_transactions")
          .select("loan_number,branch,category_6,category_7,movement,month,year")
          .in("loan_number", chunk);
        if (sources.length) q = q.in("source", sources);
        return q;
      });
      txs.push(...rows);
    }

    // ── Aggregate by loan and concept ───────────────────────────────────────
    // By concept, never by row. There are genuine reversal pairs in the data —
    // one loan carries Processing Income +1,736.17 and -1,736.17, another Fee
    // Income +333 and -333 — which are reclassifications. Listed as rows they
    // read as duplicates; summed by category_7 they cancel, which is what they
    // mean.
    type Agg = {
      concepts: Record<string, number>;
      groups: Record<string, number>;
      months: Set<string>;
      /** category_7 -> branches the amount is booked in. Not the loan's branch:
       *  DM Margin is booked in 700 on loans the other branches originated. */
      conceptBranches: Record<string, Set<string>>;
    };
    const agg = new Map<string, Agg>();
    for (const t of txs) {
      if (!t.category_7) continue;
      let a = agg.get(t.loan_number);
      if (!a) { a = { concepts: {}, groups: {}, months: new Set<string>(), conceptBranches: {} }; agg.set(t.loan_number, a); }
      const v = money(t.movement);
      a.concepts[t.category_7] = (a.concepts[t.category_7] ?? 0) + v;
      if (t.branch) (a.conceptBranches[t.category_7] ??= new Set()).add(t.branch);
      const g = t.category_6 ?? "(none)";
      a.groups[g] = (a.groups[g] ?? 0) + v;
      if (t.month && (t.month !== month || t.year !== year)) a.months.add(`${t.month} ${t.year}`);
    }

    const rows: LoanDetailRow[] = loans.map((l) => {
      const a = agg.get(l.loan_number) ?? { concepts: {}, groups: {}, months: new Set<string>(), conceptBranches: {} };
      const amount = money(l.loan_amount);

      const revenue = a.groups["Revenue"] ?? 0;
      const costs   = a.groups["Direct Production Costs"] ?? 0;
      const net     = NET_GROUPS.reduce((s, g) => s + (a.groups[g] ?? 0), 0);

      // An account is out of rule when the BRANCH IT IS BOOKED IN does not
      // normally carry it — not when it differs from the loan's branch. DM
      // Margin is always booked in 700, on loans every branch originates, so
      // comparing against the loan's branch flagged 308 of 374 loans as
      // anomalous when almost none of them were.
      const unexpected = ALL_MARGIN_ACCOUNTS.filter((acc) => {
        if ((a.concepts[acc] ?? 0) === 0) return false;
        const booked = a.conceptBranches[acc];
        if (!booked || booked.size === 0) return false;
        return [...booked].some((b) => !expectedMarginAccounts(b).includes(acc));
      });
      const noMargin = ALL_MARGIN_ACCOUNTS.every((acc) => (a.concepts[acc] ?? 0) === 0);

      return {
        loan_number: l.loan_number,
        borrower_name: l.borrower_name,
        loan_officer: l.loan_officer,
        branch: l.branch!,
        loan_program: l.loan_program,
        loan_info_channel: l.loan_info_channel,
        loan_amount: amount,
        b2b: !!l.b2b,
        processing: !!l.processing,
        support_on_demand: !!l.support_on_demand,
        concepts: a.concepts,
        concept_branches: Object.fromEntries(
          Object.entries(a.conceptBranches).map(([k, v]) => [k, [...v].sort()]),
        ),
        unexpected_accounts: unexpected,
        foreign_months: [...a.months].sort(),
        revenue, costs, net,
        net_bps: bps(net, amount),
        no_margin: noMargin,
      };
    });

    // ── Revenue that cannot be placed on any of these loans ─────────────────
    // Both buckets are scoped to this month so their figures sit alongside the
    // rest rather than describing a different period.
    const knownLoans = new Set(rawLoans.map((l) => l.loan_number as string));

    const monthTx = await page(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = supabase
        .from("pl_transactions")
        .select("loan_number,branch,category_6,category_7,movement")
        .eq("month", month)
        .eq("year", year)
        .in("category_7", ALL_MARGIN_ACCOUNTS as string[]);
      if (sources.length) q = q.in("source", sources);
      return q;
    });

    const orphanAgg = new Map<string, { branch: string | null; concepts: Record<string, number> }>();
    let unattributed = 0;
    let unattributedRows = 0;
    for (const t of monthTx) {
      const v = money(t.movement);
      if (!t.loan_number) { unattributed += v; unattributedRows++; continue; }
      if (knownLoans.has(t.loan_number)) continue;
      let o = orphanAgg.get(t.loan_number);
      if (!o) { o = { branch: t.branch, concepts: {} }; orphanAgg.set(t.loan_number, o); }
      if (t.category_7) o.concepts[t.category_7] = (o.concepts[t.category_7] ?? 0) + v;
    }

    const orphans = [...orphanAgg.entries()].map(([loan_number, o]) => ({
      loan_number,
      branch: o.branch,
      concepts: o.concepts,
      total: Object.values(o.concepts).reduce((s, v) => s + v, 0),
    }));

    return NextResponse.json({
      month, year,
      loans: rows,
      orphans,
      orphans_total: orphans.reduce((s, o) => s + o.total, 0),
      unattributed_total: unattributed,
      unattributed_rows: unattributedRows,
      net_groups: NET_GROUPS,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
