import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { resolveLoanBranchAlias } from "@/lib/loan-branch";
import { NET_GROUPS } from "@/lib/loan-detail-accounts";
import {
  LO_COMP_ACCOUNTS,
  LO_COMP_EXCLUDED_ACCOUNTS,
  matchOfficersToPayroll,
  personKey,
} from "@/lib/lo-payroll-match";

export const dynamic = "force-dynamic";

/**
 * What a loan officer produced against what they were paid.
 *
 * ─── THE THREE BUCKETS ARE THE POINT ───────────────────────────────────────
 * A loan officer whose payroll name did not match would otherwise appear to be
 * paid nothing, which is the exact opposite of what this view is for. So nobody
 * is dropped and nobody is silently zero: every officer and every paid person
 * lands in one of three named buckets, and the three add back to the ledger.
 *
 *   paired        produced and paid — the ordinary case
 *   producing     closings, no compensation located
 *   paid          compensation, no closings
 *
 * The third is not a defect. Loan officer assistants and sales managers are
 * paid through these accounts and do not close loans; so, apparently, are some
 * people who should. Telling the two apart is the reader's job, and the account
 * a person is paid through is the evidence, which is why it travels per row.
 */

export interface LoPnlPerson {
  /** Officer name where there is one, otherwise the payroll name. */
  name: string;
  bucket: "paired" | "producing" | "paid";
  /** The payroll description, when a person was located in the payroll. */
  payroll_name: string | null;
  /** Why no compensation is shown — only on `producing`. */
  unpaid_reason: "no_name_in_payroll" | "undecided_match" | null;
  closings: number;
  volume: number;
  /** category_7 → summed movement, the same shape the loan cards use. */
  concepts: Record<string, number>;
  revenue: number;
  /** GL account name → summed movement. Negative: these are costs. */
  comp_by_account: Record<string, number>;
  compensation: number;
  /** revenue + compensation. Compensation is already negative. */
  net: number;
  /** Against the officer's own originated volume. Null without volume. */
  net_bps: number | null;
  branches: string[];
  /** Matched through the alias table rather than by the name rule. */
  via_alias: boolean;
}

export interface LoPnlResult {
  people: LoPnlPerson[];
  counts: { paired: number; producing: number; paid: number };
  totals: {
    volume: number; revenue: number; compensation: number; net: number;
    /** Compensation in each bucket, so the control total can be checked. */
    compensation_paired: number; compensation_paid: number;
  };
  /**
   * The ledger figure the three buckets must add up to.
   *
   * Present so the screen can show the check rather than assert it. It caught a
   * real defect: two spellings of one officer both claimed the same payroll
   * person and the total came out 4.540,47 heavy.
   */
  control: {
    accounts_total: number;
    buckets_total: number;
    /**
     * Rows of the five accounts carrying no name at all.
     *
     * They belong to nobody, so they cannot enter a bucket — and they cannot be
     * dropped either, or the control total would be reconciled by ignoring the
     * thing it exists to catch. Shown as their own line.
     */
    unnamed_total: number;
    unnamed_rows: number;
    /** accounts_total − buckets_total − unnamed_total. Zero or the check failed. */
    difference: number;
    accounts: Record<string, string>;
  };
  /** Named so the cost side is not read as complete. */
  excluded: {
    accounts: Record<string, string>;
    total: number;
    rows: number;
  };
  aliases_used: number;
  aliases_available: boolean;
  /** Officers whose only candidate was claimed by another officer, by name. */
  undecided: string[];
  scope: { months: string[]; years: number[] };
}

const money = (v: unknown): number => (v == null ? 0 : Number(v));

/** Every unbounded select has to paginate: PostgREST caps a page at 1000 rows. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function page(build: () => any): Promise<Record<string, any>[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: Record<string, any>[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().order("id", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

export async function GET(req: NextRequest) {
  const supabase = createServerClient();
  const { searchParams } = new URL(req.url);
  const months = searchParams.getAll("month");
  const years = searchParams.getAll("year").map(Number).filter((n) => !isNaN(n));

  try {
    // ── The loans each officer closed ────────────────────────────────────────
    // Every channel, banked and brokered alike. The question here is what a
    // person produced, and a brokered loan was still produced by them — unlike
    // the loan detail window, where mixing channels would dilute a bps against
    // volume the margin was never going to be earned on.
    const loans = await page(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = supabase.from("loan_officials")
        .select("id,loan_number,loan_officer,loan_amount,branch,month,year,loan_info_channel");
      if (months.length) q = q.in("month", months);
      if (years.length) q = q.in("year", years);
      return q;
    });

    // ── Everything those loans earned, and everything the payroll paid ───────
    const txs = await page(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = supabase.from("pl_transactions")
        .select("id,gl_code,gl_name,category_6,category_7,check_description,loan_number,loan_number_incomplete,movement,month,year");
      if (months.length) q = q.in("month", months);
      if (years.length) q = q.in("year", years);
      return q;
    });

    // ── Confirmed equivalences, if the table has been created ────────────────
    // Absent table is not an error: the module works without it, with two people
    // sitting in the "producing" bucket until somebody decides they are the same
    // person. Failing here would make an unapplied migration look like an outage.
    let aliases: { payroll_name: string; loan_officer: string }[] = [];
    let aliasesAvailable = true;
    {
      const { data, error } = await supabase
        .from("lo_payroll_aliases").select("payroll_name,loan_officer");
      if (error) aliasesAvailable = false;
      else aliases = (data ?? []) as { payroll_name: string; loan_officer: string }[];
    }

    // ── Revenue per loan ─────────────────────────────────────────────────────
    const revByLoan = new Map<string, Record<string, number>>();
    for (const t of txs) {
      if (!NET_GROUPS.includes(t.category_6) || !t.loan_number || t.loan_number_incomplete || !t.category_7) continue;
      const a = revByLoan.get(t.loan_number) ?? {};
      a[t.category_7] = (a[t.category_7] ?? 0) + money(t.movement);
      revByLoan.set(t.loan_number, a);
    }

    // ── Officers ─────────────────────────────────────────────────────────────
    type Officer = {
      name: string; closings: number; volume: number;
      concepts: Record<string, number>; branches: Set<string>;
    };
    const officers = new Map<string, Officer>();
    for (const l of loans) {
      const raw = (l.loan_officer as string | null)?.trim();
      if (!raw) continue;
      const k = personKey(raw);
      const o = officers.get(k) ?? { name: raw, closings: 0, volume: 0, concepts: {}, branches: new Set<string>() };
      o.closings++;
      o.volume += money(l.loan_amount);
      const br = resolveLoanBranchAlias(l.branch as string | null);
      if (br) o.branches.add(br);
      for (const [c, v] of Object.entries(revByLoan.get(l.loan_number) ?? {})) {
        o.concepts[c] = (o.concepts[c] ?? 0) + v;
      }
      officers.set(k, o);
    }

    // ── Paid people ──────────────────────────────────────────────────────────
    type Paid = { name: string; total: number; byAccount: Record<string, number>; rows: number };
    const payroll = new Map<string, Paid>();
    for (const t of txs) {
      const account = LO_COMP_ACCOUNTS[t.gl_code as string];
      if (!account) continue;
      const desc = (t.check_description as string | null)?.trim();
      if (!desc) continue;
      const k = personKey(desc);
      if (!k) continue;
      const p = payroll.get(k) ?? { name: desc, total: 0, byAccount: {}, rows: 0 };
      p.rows++;
      p.total += money(t.movement);
      p.byAccount[account] = (p.byAccount[account] ?? 0) + money(t.movement);
      payroll.set(k, p);
    }

    const match = matchOfficersToPayroll<Officer, Paid>({
      officers, payroll,
      officerName: (o) => o.name,
      payrollName: (p) => p.name,
      aliases,
    });
    const aliasKeys = new Set(aliases.map((a) => personKey(a.loan_officer)));

    // ── The three buckets ────────────────────────────────────────────────────
    const people: LoPnlPerson[] = [];
    const bpsOf = (net: number, vol: number) => (vol ? (net / vol) * 10000 : null);

    for (const [k, o] of officers) {
      const pk = match.pairs.get(k);
      const p = pk ? payroll.get(pk)! : null;
      const revenue = Object.values(o.concepts).reduce((s, v) => s + v, 0);
      const compensation = p?.total ?? 0;
      people.push({
        name: o.name,
        bucket: p ? "paired" : "producing",
        payroll_name: p?.name ?? null,
        unpaid_reason: p ? null
          : match.officersUndecided.includes(k) ? "undecided_match" : "no_name_in_payroll",
        closings: o.closings,
        volume: o.volume,
        concepts: o.concepts,
        revenue,
        comp_by_account: p?.byAccount ?? {},
        compensation,
        net: revenue + compensation,
        net_bps: bpsOf(revenue + compensation, o.volume),
        branches: [...o.branches].sort(),
        via_alias: aliasKeys.has(k),
      });
    }
    for (const k of match.payrollUnclaimed) {
      const p = payroll.get(k)!;
      people.push({
        name: p.name,
        bucket: "paid",
        payroll_name: p.name,
        unpaid_reason: null,
        closings: 0, volume: 0, concepts: {}, revenue: 0,
        comp_by_account: p.byAccount,
        compensation: p.total,
        net: p.total,
        net_bps: null,
        branches: [],
        via_alias: false,
      });
    }

    // ── The control total ────────────────────────────────────────────────────
    // Every row of the five accounts, whether or not it carries a usable name.
    let accountsTotal = 0, unnamedTotal = 0, unnamedRows = 0;
    for (const t of txs) {
      if (!LO_COMP_ACCOUNTS[t.gl_code as string]) continue;
      accountsTotal += money(t.movement);
      const desc = (t.check_description as string | null)?.trim();
      if (!desc || !personKey(desc)) { unnamedTotal += money(t.movement); unnamedRows++; }
    }
    const bucketsTotal = people.reduce((s, p) => s + p.compensation, 0);

    let excludedTotal = 0, excludedRows = 0;
    for (const t of txs) {
      if (!LO_COMP_EXCLUDED_ACCOUNTS[t.gl_code as string]) continue;
      excludedTotal += money(t.movement);
      excludedRows++;
    }

    const counts = {
      paired: people.filter((p) => p.bucket === "paired").length,
      producing: people.filter((p) => p.bucket === "producing").length,
      paid: people.filter((p) => p.bucket === "paid").length,
    };

    const result: LoPnlResult = {
      people: people.sort((a, b) => b.net - a.net),
      counts,
      totals: {
        volume: people.reduce((s, p) => s + p.volume, 0),
        revenue: people.reduce((s, p) => s + p.revenue, 0),
        compensation: bucketsTotal,
        net: people.reduce((s, p) => s + p.net, 0),
        compensation_paired: people.filter((p) => p.bucket === "paired").reduce((s, p) => s + p.compensation, 0),
        compensation_paid: people.filter((p) => p.bucket === "paid").reduce((s, p) => s + p.compensation, 0),
      },
      control: {
        accounts_total: accountsTotal,
        buckets_total: bucketsTotal,
        unnamed_total: unnamedTotal,
        unnamed_rows: unnamedRows,
        difference: accountsTotal - bucketsTotal - unnamedTotal,
        accounts: LO_COMP_ACCOUNTS,
      },
      excluded: { accounts: LO_COMP_EXCLUDED_ACCOUNTS, total: excludedTotal, rows: excludedRows },
      aliases_used: match.fromAliases,
      aliases_available: aliasesAvailable,
      undecided: match.officersUndecided.map((k) => officers.get(k)?.name ?? k).sort(),
      scope: { months, years },
    };
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
