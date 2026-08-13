import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import {
  normalizeLoanBranch,
  resolveBaseBranches,
  baseIsDivisionWide,
} from "@/lib/loan-branch";

export const dynamic = "force-dynamic";

const PAGE = 1000;
const IN_CHUNK = 500;

const LO_SELECT =
  "loan_number,loan_info_channel,loan_amount,branch,month,year," +
  "b2b,processing,support_on_demand,affinity,recruitment";

type OfficialRow = {
  loan_number: string;
  loan_info_channel: string | null;
  loan_amount: number | string | null;
  branch: string | null;
  month?: string | null;
  year?: number | null;
  b2b: boolean;
  processing: boolean;
  support_on_demand: boolean;
  affinity: boolean;
  recruitment: boolean;
};

export interface MonthMetrics {
  total: number; banked: number; brokered: number; other: number;
  amount_total: number; amount_banked: number; amount_brokered: number; amount_other: number;
  b2b: number; processing: number; support_on_demand: number; affinity: number; recruitment: number;
}

function emptyMetrics(): MonthMetrics {
  return {
    total: 0, banked: 0, brokered: 0, other: 0,
    amount_total: 0, amount_banked: 0, amount_brokered: 0, amount_other: 0,
    b2b: 0, processing: 0, support_on_demand: 0, affinity: 0, recruitment: 0,
  };
}

const money = (v: number | string | null | undefined): number => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Channel bucket.
 *
 * LIKE 'Banked%' rather than = 'Banked - Retail': the only value present today
 * is "Banked - Retail", but the name says a second banked channel is expected
 * and an equality test would silently drop it. Verified equivalent on the
 * current data — both match the same 340 rows and the same $121,608,969.
 *
 * Anything else, INCLUDING NULL, lands in `other`. The previous version tested
 * `else if (o.loan_info_channel)`, so a null channel counted towards the total
 * and towards no bucket at all: the breakdown quietly failed to add up to the
 * figure printed beside it.
 */
function channelOf(c: string | null): "banked" | "brokered" | "other" {
  const v = (c ?? "").trim();
  if (v.startsWith("Banked")) return "banked";
  if (v === "Brokered") return "brokered";
  return "other";
}

/** Accumulates one loan into a month bucket. Counts and amounts together, from
 *  the same row, so the two can never describe different sets of loans. */
function accumulate(m: MonthMetrics, o: OfficialRow) {
  const amt = money(o.loan_amount);
  const bucket = channelOf(o.loan_info_channel);

  m.total++;
  m.amount_total += amt;
  if (bucket === "banked")        { m.banked++;   m.amount_banked   += amt; }
  else if (bucket === "brokered") { m.brokered++; m.amount_brokered += amt; }
  else                            { m.other++;    m.amount_other    += amt; }

  if (o.b2b)               m.b2b++;
  if (o.processing)        m.processing++;
  if (o.support_on_demand) m.support_on_demand++;
  if (o.affinity)          m.affinity++;
  if (o.recruitment)       m.recruitment++;
}

/** Paged read of loan_officials. Unbounded selects stop at 1000 rows on this
 *  project; the table is at 379 today and grows with every monthly upload. */
async function fetchOfficials(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  years: number[],
  loanNumbers: string[] | null,
): Promise<OfficialRow[]> {
  const build = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = supabase.from("loan_officials").select(LO_SELECT);
    if (years.length) q = q.in("year", years);
    return q;
  };

  // NOTE: the branch filter is deliberately NOT applied in SQL. Branch names
  // need normalizing first (Affinity → 716) and rows outside the division need
  // excluding, and neither can be expressed as a column predicate. Filtering
  // happens in memory, after normalizeLoanBranch.
  const out: OfficialRow[] = [];

  const pageThrough = async (mod: (q: unknown) => unknown) => {
    for (let from = 0; ; from += PAGE) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (mod(build()) as any)
        .order("loan_number", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      out.push(...(data as OfficialRow[]));
      if (data.length < PAGE) break;
    }
  };

  if (loanNumbers === null) {
    await pageThrough((q) => q);
  } else {
    if (loanNumbers.length === 0) return [];
    // Chunked: a single .in() with thousands of loan numbers overruns the URL.
    for (let i = 0; i < loanNumbers.length; i += IN_CHUNK) {
      const chunk = loanNumbers.slice(i, i + IN_CHUNK);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await pageThrough((q) => (q as any).in("loan_number", chunk));
    }
  }
  return out;
}

/** Paged read of the loan numbers a P&L filter selects. */
async function fetchLoanNumbers(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  years: number[], branches: string[], sources: string[], ccIds: string[],
): Promise<string[]> {
  const seen = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = supabase
      .from("pl_transactions")
      .select("loan_number")
      .not("loan_number", "is", null)
      .not("loan_number_incomplete", "eq", true);
    if (years.length)    q = q.in("year", years);
    if (branches.length) q = q.in("branch", branches);
    if (sources.length)  q = q.in("source", sources);
    if (ccIds.length)    q = q.in("cost_center_id", ccIds);

    const { data, error } = await q.order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (const r of data as { loan_number: string }[]) seen.add(r.loan_number);
    if (data.length < PAGE) break;
  }
  return [...seen];
}

export async function GET(req: NextRequest) {
  const supabase = createServerClient();
  const sp = new URL(req.url).searchParams;

  const years    = sp.getAll("year").map(Number).filter(Boolean);
  const branches = sp.getAll("branch");
  const sources  = sp.getAll("source");
  const ccIds    = sp.getAll("cost_center_id");
  const groupBy  = sp.get("group_by");

  try {
    // ── Per-month mode ──────────────────────────────────────────────────────
    if (groupBy === "month") {
      // sources and cost_center_id are properties of pl_transactions, not of
      // loan_officials, so they narrow the loan list through the transactions
      // that reference those loans. Previously this mode ignored them: the UI
      // offered the filters and the panel answered as if they were not set.
      const narrowByTx = sources.length > 0 || ccIds.length > 0;
      const loanNumbers = narrowByTx
        ? await fetchLoanNumbers(supabase, years, branches, sources, ccIds)
        : null;

      const raw = await fetchOfficials(supabase, years, loanNumbers);

      // ONE row set. Everything below is an aggregate of `rows` — the count and
      // the amount for a month are accumulated from the same record in the same
      // pass, so they cannot describe different sets of loans.
      const rows = raw
        .map((o) => ({ ...o, branch: normalizeLoanBranch(o.branch) }))
        .filter((o) => o.branch !== null);

      const excluded = raw.length - rows.length;

      // ── One branch rule, applied once ───────────────────────────────────────
      // The cards and the bps denominator MUST select the same loans. They used
      // to filter separately — the cards on `branches` directly, the base
      // through resolveBaseBranches — and the corporate branch broke the pair:
      // filtering to 700 counted zero loans (nothing normalizes to "700") while
      // the base correctly used every branch. Cards at zero, bps computed off a
      // full denominator.
      //
      // Now there is a single predicate and a single pass, so the two cannot
      // disagree: null means every branch, an array means those branches.
      const effectiveBranches = resolveBaseBranches(branches);
      const inScope = (b: string) => !effectiveBranches || effectiveBranches.includes(b);

      const by_month: Record<string, MonthMetrics> = {};
      const bps_base_by_month: Record<string, { all: number; banked: number; brokered: number }> = {};

      for (const o of rows) {
        if (!o.month) continue;
        if (!inScope(o.branch!)) continue;

        (by_month[o.month] ??= emptyMetrics());
        accumulate(by_month[o.month], o);

        const b = (bps_base_by_month[o.month] ??= { all: 0, banked: 0, brokered: 0 });
        const amt = money(o.loan_amount);
        b.all += amt;
        const bucket = channelOf(o.loan_info_channel);
        if (bucket === "banked") b.banked += amt;
        else if (bucket === "brokered") b.brokered += amt;
      }

      // Branches the user asked for that carry no loans at all. Only meaningful
      // when the filter is actually narrowing: under the corporate rule the
      // effective scope is every branch, and reporting 700 as "unmatched" would
      // warn about the very case the rule exists to handle.
      const present = new Set(rows.map((o) => o.branch!));
      const unmatched_branches = effectiveBranches
        ? effectiveBranches.filter((b) => !present.has(b))
        : [];

      // Invariant: the three buckets must reconstruct the total. If a channel
      // ever escapes categorisation, say so rather than printing a breakdown
      // that does not add up to the figure above it.
      const drift = Object.entries(by_month)
        .filter(([, m]) =>
          m.banked + m.brokered + m.other !== m.total ||
          Math.abs(m.amount_banked + m.amount_brokered + m.amount_other - m.amount_total) > 0.01)
        .map(([month]) => month);

      return NextResponse.json({
        by_month,
        bps_base_by_month,
        base_is_division_wide: baseIsDivisionWide(branches),
        unmatched_branches,
        excluded_loans: excluded,
        bucket_drift_months: drift,
      });
    }

    // ── Total mode ──────────────────────────────────────────────────────────
    const loanNumbers = await fetchLoanNumbers(supabase, years, branches, sources, ccIds);
    if (loanNumbers.length === 0) return NextResponse.json(emptyMetrics());

    const raw = await fetchOfficials(supabase, [], loanNumbers);
    const totals = emptyMetrics();
    for (const o of raw) {
      if (normalizeLoanBranch(o.branch) === null) continue;
      accumulate(totals, o);
    }
    return NextResponse.json(totals);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
