import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { normalizeLoanBranch, resolveBaseBranches } from "@/lib/loan-branch";
import {
  ALL_MARGIN_ACCOUNTS,
  MARGIN_FOR_PERIOD,
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

export interface LoanDetailLine {
  gl_code: string;
  gl_name: string;
  category_7: string;
  amount: number;
}

/**
 * Display order for the GL lines.
 *
 * The three that carry the story come first, always in this order, so the same
 * concept sits at the same height on every card and two cards side by side can
 * be read across. Sorting by amount put them in a different place on each one.
 *
 * Whatever is left follows, grouped by its category_7 so the GL accounts that
 * make up one concept stay together — Processing Income (41830) next to
 * Processing Fees (55275) — with the larger concepts first and, inside each,
 * the larger amounts first.
 */
const LINE_ORDER: readonly string[] = ["Back-end Margin", "Discount Income", "Front-end Margin"];

function orderLines(lines: LoanDetailLine[]): LoanDetailLine[] {
  const anchored: LoanDetailLine[] = [];
  for (const c7 of LINE_ORDER) {
    anchored.push(
      ...lines.filter((l) => l.category_7 === c7).sort((a, b) => b.amount - a.amount),
    );
  }

  const rest = lines.filter((l) => !LINE_ORDER.includes(l.category_7));
  const byConcept = new Map<string, LoanDetailLine[]>();
  for (const l of rest) (byConcept.get(l.category_7) ?? byConcept.set(l.category_7, []).get(l.category_7)!).push(l);

  const tail = [...byConcept.entries()]
    .map(([c7, ls]) => ({ c7, ls, total: ls.reduce((s, l) => s + l.amount, 0) }))
    .sort((a, b) => b.total - a.total)
    .flatMap((g) => g.ls.sort((a, b) => b.amount - a.amount));

  return [...anchored, ...tail];
}

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
  /** category_7 → summed movement. Kept for the column rules. */
  concepts: Record<string, number>;
  /** One line per GL account, in the fixed display order. */
  lines: LoanDetailLine[];
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

    // Banked only. Brokered loans earn through a different mechanism and
    // mixing them dilutes every bps in the window against volume this margin
    // was never going to be earned on. Measured: 336 of the 375 loans in
    // scope, $120,424,191 of $131,911,354.
    const isBanked = (c: string | null) => (c ?? "").trim().startsWith("Banked");

    const loans = rawLoans
      .map((l) => ({ ...l, branch: normalizeLoanBranch(l.branch) }))
      .filter((l) => l.branch !== null && inScope(l.branch) && isBanked(l.loan_info_channel));

    const loanNumbers = loans.map((l) => l.loan_number as string);

    // ── What those loans earned, in the books the filter asks for ───────────
    // The raw branch filter, NOT resolveBaseBranches. The two answer different
    // questions: resolveBaseBranches decides which loans belong to the card,
    // this decides whose accounting we are reading. With branch 710 selected
    // the card must show 710's books for the loan and nothing else — netting
    // 710's -15.76 of Fee Income against 700's +333.00 into a single 317.24
    // describes an entity nobody selected.
    const bookedIn = branches.length > 0 ? branches : null;

    // Not restricted to this month: a loan's margin sometimes lands later, and
    // dropping it would show the loan as having earned nothing. The month it
    // actually landed in travels with the row so the window can say so.
    const txs: Array<{ loan_number: string; branch: string | null; gl_code: string | null; gl_name: string | null; category_6: string | null; category_7: string | null; movement: number | string | null; month: string | null; year: number | null }> = [];
    for (let i = 0; i < loanNumbers.length; i += IN_CHUNK) {
      const chunk = loanNumbers.slice(i, i + IN_CHUNK);
      if (chunk.length === 0) break;
      const rows = await page(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let q: any = supabase
          .from("pl_transactions")
          .select("loan_number,branch,gl_code,gl_name,category_6,category_7,movement,month,year")
          .in("loan_number", chunk)
          // Only what makes up a loan's result. SG&A and Personnel Costs are
          // not shown anywhere — not in the net, not folded behind a toggle.
          // A marketing campaign is not caused by one loan, and showing it
          // would invite the reader to hold the loan responsible for it.
          .in("category_6", NET_GROUPS as string[]);
        if (bookedIn) q = q.in("branch", bookedIn);
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
      /** gl_code -> one displayable line. category_7 groups several GL
       *  accounts into one figure that cannot be tied back to the ledger:
       *  "Fee Income, Net" is Cures (41215) and Other HUD Fees (41205)
       *  netted together, and only the GL split reconciles. */
      lines: Record<string, { gl_code: string; gl_name: string; category_7: string; amount: number }>;
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
      if (!a) { a = { concepts: {}, lines: {}, groups: {}, months: new Set<string>(), conceptBranches: {} }; agg.set(t.loan_number, a); }
      const v = money(t.movement);
      a.concepts[t.category_7] = (a.concepts[t.category_7] ?? 0) + v;
      const gl = t.gl_code ?? "—";
      const line = (a.lines[gl] ??= { gl_code: gl, gl_name: t.gl_name ?? t.category_7, category_7: t.category_7, amount: 0 });
      line.amount += v;
      if (t.branch) (a.conceptBranches[t.category_7] ??= new Set()).add(t.branch);
      const g = t.category_6 ?? "(none)";
      a.groups[g] = (a.groups[g] ?? 0) + v;
      // Only the three margin accounts decide the "margin landed elsewhere"
      // label. Revenue that is not margin — Fee Income, Processing Income —
      // used to tag a loan on $89.00 while its real margin sat in the card's
      // own month.
      if (t.month && MARGIN_FOR_PERIOD.includes(t.category_7) &&
          (t.month !== month || t.year !== year)) {
        a.months.add(`${t.month} ${t.year}`);
      }
    }

    const rows: LoanDetailRow[] = loans.map((l) => {
      const a = agg.get(l.loan_number) ?? { concepts: {}, lines: {}, groups: {}, months: new Set<string>(), conceptBranches: {} };
      const amount = money(l.loan_amount);

      // Revenue is the whole story here: NET_GROUPS holds one group, so the
      // net is its total. costs stays at zero for the shape of the payload.
      const revenue = a.groups["Revenue"] ?? 0;
      const costs   = 0;
      const net     = revenue;

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
        lines: orderLines(Object.values(a.lines).filter((x) => x.amount !== 0)),
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

    // ── The month, as one card ──────────────────────────────────────────────
    // Same concepts, same structure, same branch scope as the individual cards.
    // The denominator is the volume of EVERY loan in scope, including the ones
    // that earned nothing: that volume was originated either way, and dropping
    // the silent loans would flatter the month by shrinking the base it is
    // measured against.
    const summaryConcepts: Record<string, number> = {};
    const summaryLines: Record<string, LoanDetailLine> = {};
    for (const r of rows) {
      for (const [c, v] of Object.entries(r.concepts)) {
        summaryConcepts[c] = (summaryConcepts[c] ?? 0) + v;
      }
      for (const ln of r.lines) {
        const acc = (summaryLines[ln.gl_code] ??= { ...ln, amount: 0 });
        acc.amount += ln.amount;
      }
    }
    const summaryVolume  = rows.reduce((s, r) => s + r.loan_amount, 0);
    const summaryRevenue = rows.reduce((s, r) => s + r.revenue, 0);
    const summaryCosts   = 0;
    const summaryNet     = summaryRevenue;

    const summary = {
      loan_count: rows.length,
      /** Banked only. Stated in the payload so the header can say so rather
       *  than letting the figure be read as the month's whole volume. */
      banked_only: true,
      volume: summaryVolume,
      /** Originated volume that received no margin at all. */
      without_margin: rows.filter((r) => r.no_margin).length,
      concepts: summaryConcepts,
      lines: orderLines(Object.values(summaryLines).filter((l) => l.amount !== 0)),
      revenue: summaryRevenue,
      costs: summaryCosts,
      net: summaryNet,
      net_bps: bps(summaryNet, summaryVolume),
    };

    // ── Margin in these books that is not on one of this card's loans ───────
    //
    // The label used to say "Not in the master loan list", and it was false.
    // The test was membership of loan_officials FOR THIS MONTH — no branch and
    // no channel entered it — so a loan that originated in April and earned in
    // June read as missing from a list it has always been in. Measured on the
    // five reported cases: all five exist, all branch 703, four from April and
    // one from May.
    //
    // Three different things were collapsed into one, and only the first is an
    // absent record:
    //
    //   missing        the number appears in no row of loan_officials
    //   other_period   it does, but the loan originated in another month
    //   out_of_scope   it originated this month, but the loan is not on this
    //                  card — another branch, or not Banked
    //
    // The last two are not gaps in the data. They are revenue from elsewhere
    // turning up in the books being read: worth knowing, and not an error.
    // Measured across the whole table: 7 missing, 10 from another period, and
    // 0 out of scope with no branch filter applied.
    const cardLoans = new Set(loans.map((l) => l.loan_number as string));

    const monthTx = await page(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = supabase
        .from("pl_transactions")
        .select("loan_number,branch,category_6,category_7,movement")
        .eq("month", month)
        .eq("year", year)
        .in("category_7", ALL_MARGIN_ACCOUNTS as string[]);
      if (bookedIn) q = q.in("branch", bookedIn);
      if (sources.length) q = q.in("source", sources);
      return q;
    });

    /**
     * Keyed by loan AND by the branch it was booked in, not by loan alone.
     *
     * A transfer is +V in one branch and −V in another. Summed per loan they
     * cancel, so with no branch filter the whole thing showed as 0,00 with
     * nothing to explain it — the one reading where both halves are on screen
     * was the one that said least. One row per side, each pointing at the
     * other.
     */
    const strayAgg = new Map<string, { loan_number: string; branch: string | null; concepts: Record<string, number> }>();
    let unattributed = 0;
    let unattributedRows = 0;
    for (const t of monthTx) {
      const v = money(t.movement);
      if (!t.loan_number) { unattributed += v; unattributedRows++; continue; }
      // Against the card's own list, not against the month's master. A loan in
      // the master but not on this card was skipped in silence, so its revenue
      // appeared in neither table.
      if (cardLoans.has(t.loan_number)) continue;
      const k = `${t.loan_number}|${t.branch ?? ""}`;
      let o = strayAgg.get(k);
      if (!o) { o = { loan_number: t.loan_number, branch: t.branch, concepts: {} }; strayAgg.set(k, o); }
      if (t.category_7) o.concepts[t.category_7] = (o.concepts[t.category_7] ?? 0) + v;
    }

    const strayNumbers = [...new Set([...strayAgg.values()].map((o) => o.loan_number))];

    // Every period of those loans, so the window can say which one each belongs
    // to instead of asserting it belongs to none.
    const originRows = strayNumbers.length
      ? await page(() =>
          supabase
            .from("loan_officials")
            .select("loan_number,branch,month,year,loan_info_channel")
            .in("loan_number", strayNumbers),
        )
      : [];

    /**
     * The same rows across every branch, deliberately WITHOUT the branch filter.
     *
     * A transfer between branches is +V in one and −V in another, and through a
     * filter only one half is visible — which is exactly how one side of a pair
     * reads as revenue appearing from nowhere. To say "this is a transfer, its
     * other half is in 724", the other half has to be looked at.
     */
    const acrossBranches = strayNumbers.length
      ? await page(() =>
          supabase
            .from("pl_transactions")
            .select("loan_number,branch,category_7,movement")
            .eq("month", month)
            .eq("year", year)
            .in("category_7", ALL_MARGIN_ACCOUNTS as string[])
            .in("loan_number", strayNumbers),
        )
      : [];

    const stray = [...strayAgg.values()].map((agg) => {
      const loan_number = agg.loan_number;
      const origins = originRows.filter((r) => r.loan_number === loan_number);
      const here = origins.find((r) => r.month === month && r.year === year);
      const origin = here ?? origins[0] ?? null;

      // An exact opposite of the same concept in another branch, same month.
      // Equal magnitude and opposite sign is the whole test: this is one entry
      // moved, not two independent amounts that happen to cancel.
      const mine = acrossBranches.filter((r) => r.loan_number === loan_number);
      const counterparts: { branch: string; concept: string; amount: number }[] = [];
      for (const [concept, amount] of Object.entries(agg.concepts)) {
        for (const r of mine) {
          if (r.category_7 !== concept || r.branch === agg.branch) continue;
          if (Math.abs(money(r.movement) + amount) < 0.005) {
            counterparts.push({ branch: r.branch as string, concept, amount: money(r.movement) });
          }
        }
      }

      return {
        loan_number,
        branch: agg.branch,
        concepts: agg.concepts,
        total: Object.values(agg.concepts).reduce((s, v) => s + v, 0),
        kind: !origins.length ? ("missing" as const)
            : here            ? ("out_of_scope" as const)
            :                   ("other_period" as const),
        origin: origin
          ? {
              branch:  origin.branch as string | null,
              month:   origin.month as string | null,
              year:    origin.year as number | null,
              channel: origin.loan_info_channel as string | null,
            }
          : null,
        counterparts,
      };
    });

    const bucket = (k: string) => {
      const rows = stray.filter((s) => s.kind === k);
      return { rows, total: rows.reduce((s, r) => s + r.total, 0) };
    };

    return NextResponse.json({
      month, year,
      branch_filter: branches,
      loans: rows,
      summary,
      missing:      bucket("missing"),
      other_period: bucket("other_period"),
      out_of_scope: bucket("out_of_scope"),
      unattributed_total: unattributed,
      unattributed_rows: unattributedRows,
      net_groups: NET_GROUPS,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
