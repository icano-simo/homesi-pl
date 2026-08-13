"use client";

import { useEffect, useMemo, useState } from "react";
import { X, ArrowUpDown, LayoutGrid, Rows3 } from "lucide-react";
import {
  ALL_MARGIN_ACCOUNTS,
  NET_GROUPS,
  expectedMarginAccounts,
} from "@/lib/loan-detail-accounts";

interface LoanRow {
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
  concepts: Record<string, number>;
  concept_branches: Record<string, string[]>;
  unexpected_accounts: string[];
  foreign_months: string[];
  revenue: number;
  costs: number;
  net: number;
  net_bps: number | null;
  no_margin: boolean;
}

interface DetailData {
  month: string;
  year: number;
  loans: LoanRow[];
  orphans: { loan_number: string; branch: string | null; concepts: Record<string, number>; total: number }[];
  orphans_total: number;
  unattributed_total: number;
  unattributed_rows: number;
  net_groups: string[];
}

interface Props {
  open: boolean;
  month: string | null;
  /** Null when the report spans several years — see the notice in the body. */
  year: number | null;
  branches: string[];
  sources: string[];
  onClose: () => void;
}

const fmt   = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (v: number) => `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const bpsOf = (v: number, amount: number) => (amount ? (v / amount) * 10000 : null);
const fmtBps = (v: number | null) => (v == null ? "—" : v.toFixed(1));

const num = (v: number) =>
  v === 0 ? "text-slate-300 font-normal" : v < 0 ? "text-rose-600" : "text-[#001A40]";

/** Revenue concepts, most valuable first, then the rest alphabetically. */
function splitConcepts(l: LoanRow) {
  const entries = Object.entries(l.concepts).filter(([, v]) => v !== 0);
  const revenue = entries.filter(([c]) => !isCost(c)).sort((a, b) => b[1] - a[1]);
  const costs   = entries.filter(([c]) =>  isCost(c)).sort((a, b) => a[1] - b[1]);
  return { revenue, costs };
}

/**
 * Cost concepts are the ones that are not revenue. Derived from the sign of the
 * loan's own groups rather than a hardcoded list: a fixed list of item names
 * would silently drop any concept nobody thought to add, and the point of this
 * window is that nothing disappears.
 */
const COST_CONCEPTS = new Set([
  "Credit Report Expense", "U/W - TALX", "Appraisal Fee Expense",
  "Compensation Transfers", "U/W -Fraud Guard", "Condo Fees",
  "Bank Charges", "U/W - Other", "Operations Payroll",
  "Marketing Expense", "Office Expense",
]);
const isCost = (c: string) => COST_CONCEPTS.has(c);

export function LoanDetailDrawer({ open, month, year, branches, sources, onClose }: Props) {
  const [data, setData]       = useState<DetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState("");
  const [showOther, setShowOther] = useState(false);
  const [sortDesc, setSortDesc]   = useState(true);
  const [view, setView] = useState<"cards" | "table">("cards");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const key = `${month}|${year}|${branches.join(",")}|${sources.join(",")}`;

  useEffect(() => {
    if (!open || !month || !year) return;
    const p = new URLSearchParams({ month, year: String(year) });
    branches.forEach((b) => p.append("branch", b));
    sources.forEach((s) => p.append("source", s));

    let cancelled = false;
    setLoading(true); setError("");
    fetch(`/api/loan-detail?${p}`)
      .then(async (r) => {
        const d = await r.json();
        if (cancelled) return;
        if (!r.ok) { setError(d?.error ?? "Error loading loan detail"); setData(null); return; }
        setData(d as DetailData);
      })
      .catch((e) => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key]);

  const { expected, extra, otherConcepts } = useMemo(() => {
    const loans = data?.loans ?? [];
    const branchSet = new Set(loans.map((l) => l.branch));
    const exp: string[] = [];
    for (const b of branchSet) for (const a of expectedMarginAccounts(b)) if (!exp.includes(a)) exp.push(a);
    const ext = ALL_MARGIN_ACCOUNTS.filter(
      (a) => !exp.includes(a) && loans.some((l) => (l.concepts[a] ?? 0) !== 0),
    );
    const others = [...new Set(loans.flatMap((l) => Object.keys(l.concepts)))]
      .filter((c) => !ALL_MARGIN_ACCOUNTS.includes(c)).sort();
    return { expected: exp, extra: ext, otherConcepts: others };
  }, [data]);

  const sorted = useMemo(() => {
    const rows = [...(data?.loans ?? [])];
    rows.sort((a, b) => {
      const av = a.net_bps ?? -Infinity, bv = b.net_bps ?? -Infinity;
      return sortDesc ? bv - av : av - bv;
    });
    return rows;
  }, [data, sortDesc]);

  if (!open) return null;

  const marginCols = [...expected, ...extra];

  return (
    <>
      <div className="fixed inset-0 z-40 bg-slate-900/20" onClick={onClose} />
      <div
        role="dialog"
        aria-label="Loan detail"
        className="fixed inset-y-0 right-0 z-50 flex h-full w-full max-w-6xl flex-col border-l border-slate-200 bg-white shadow-2xl"
      >
        <div className="border-b border-slate-200 px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-bold text-[#001A40]">
                Loans · {month} {year ?? ""}
              </h2>
              <p className="mt-1 text-[11px] text-slate-500">
                bps divide by <span className="font-semibold text-[#001A40]">each loan&apos;s own amount</span>,
                not the monthly loan volume used in the P&amp;L grid.
              </p>
            </div>
            <button onClick={onClose} aria-label="Close"
              className="shrink-0 rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
              <X size={16} />
            </button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-full bg-slate-100 p-1">
              <ViewTab active={view === "cards"} onClick={() => setView("cards")} icon={<LayoutGrid size={12} />} label="Mini P&L Cards" />
              <ViewTab active={view === "table"} onClick={() => setView("table")} icon={<Rows3 size={12} />} label="Table List" />
            </div>
            <button
              onClick={() => setShowOther((v) => !v)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                showOther ? "border-sky-200 bg-sky-50 text-sky-900"
                          : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50"}`}
            >
              {showOther ? "Hide other concepts" : "Show other concepts"}
            </button>
            <button onClick={() => setSortDesc((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 hover:border-slate-300">
              <ArrowUpDown size={11} />
              Net bps {sortDesc ? "high → low" : "low → high"}
            </button>
            <span className="rounded-full border border-slate-200 bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-500">
              Net = {(data?.net_groups ?? NET_GROUPS).join(" + ")}
            </span>
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          {/* A month card belongs to one year; with several loaded the window has
              no period to ask for. Saying so beats a click that does nothing. */}
          {year == null && (
            <p className="m-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-medium text-amber-900">
              The report covers more than one year, so this month exists in each of them and
              the loan detail has no single period to load. Filter to a single year to open it.
            </p>
          )}
          {loading && <p className="p-5 text-sm text-slate-400">Loading…</p>}
          {error && <p className="m-5 rounded-xl border border-red-100 bg-red-50 px-4 py-2 text-xs text-red-600">{error}</p>}

          {data && !loading && view === "cards" && (
            <div className="scrollbar-thin-slate flex max-w-full flex-row gap-4 overflow-x-auto p-4 pb-6">
              {sorted.map((l) => <MiniPL key={l.loan_number} l={l} showOther={showOther} />)}
            </div>
          )}

          {data && !loading && view === "table" && (
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 z-10 bg-slate-100/95">
                <tr className="border-b-2 border-slate-200 text-left">
                  <Th>Loan</Th><Th>Borrower</Th><Th className="text-center">Br</Th>
                  <Th className="text-right">Amount</Th>
                  {marginCols.map((c) => (
                    <Th key={c} className={`text-right ${extra.includes(c) ? "bg-amber-50 text-amber-800" : ""}`}>{c}</Th>
                  ))}
                  <Th className="text-right">Costs</Th>
                  <Th className="text-right">Net</Th>
                  <Th className="text-right">Net bps</Th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((l, i) => (
                  <tr key={l.loan_number} className="border-b border-slate-200/60 hover:bg-[#A6DEFF]/25"
                      style={{ backgroundColor: i % 2 ? "#fcfdfe" : "#ffffff" }}>
                    <Td className="font-mono">
                      {l.loan_number} <Signals l={l} />
                    </Td>
                    <Td className="max-w-[160px] truncate">{l.borrower_name ?? "—"}</Td>
                    <Td className="text-center font-mono">{l.branch}</Td>
                    <Td className="text-right font-mono tabular-nums">{money(l.loan_amount)}</Td>
                    {marginCols.map((c) => (
                      <Amount key={c} v={l.concepts[c] ?? 0} amount={l.loan_amount}
                              flagged={l.unexpected_accounts.includes(c)} />
                    ))}
                    <Amount v={l.costs} amount={l.loan_amount} />
                    <Amount v={l.net} amount={l.loan_amount} bold />
                    <Td className={`text-right font-mono tabular-nums font-bold ${num(l.net)}`}>{fmtBps(l.net_bps)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {data && !loading && data.orphans.length > 0 && (
            <details className="m-5 rounded-xl border border-slate-200 bg-slate-50">
              <summary className="cursor-pointer px-4 py-2.5 text-xs font-semibold text-slate-700">
                Not in the master loan list — {data.orphans.length} loan{data.orphans.length > 1 ? "s" : ""} · {money(data.orphans_total)}
              </summary>
              <table className="w-full border-collapse text-xs">
                <tbody>
                  {data.orphans.map((o) => (
                    <tr key={o.loan_number} className="border-t border-slate-200/60">
                      <Td className="font-mono">{o.loan_number}</Td>
                      <Td className="text-center font-mono">{o.branch ?? "—"}</Td>
                      <Td className="text-right font-mono tabular-nums">{fmt(o.total)}</Td>
                      <Td className="text-right text-slate-300">—</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </div>

        <div className="border-t border-slate-200 px-5 py-3 text-[11px] text-slate-500">
          This view attributes by loan; it does not reconcile with the month&apos;s P&amp;L.
          {data && data.unattributed_rows > 0 && (
            <> {data.unattributed_rows} margin row{data.unattributed_rows > 1 ? "s" : ""} carry
            no loan number ({fmt(data.unattributed_total)}) and cannot be placed on any loan.</>
          )}
        </div>
      </div>
    </>
  );
}

// ─── Mini P&L card ────────────────────────────────────────────────────────────

function MiniPL({ l, showOther }: { l: LoanRow; showOther: boolean }) {
  const { revenue, costs } = splitConcepts(l);
  const shown = (entries: [string, number][]) =>
    showOther ? entries : entries.filter(([c]) => ALL_MARGIN_ACCOUNTS.includes(c) || isCost(c));

  return (
    <div className="flex w-[340px] shrink-0 flex-col justify-between overflow-hidden rounded-2xl border border-slate-200/90 bg-white shadow-xs transition-all hover:border-[#A6DEFF]">
      <div>
        <div className="flex flex-col gap-1 border-b border-slate-200 bg-slate-100/90 p-3.5 text-xs font-bold text-[#001A40]">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono">{l.loan_number}</span>
            <span className="rounded bg-white px-1.5 py-0.5 font-mono text-[10px]">{l.branch}</span>
          </div>
          <span className="truncate font-semibold text-slate-600">{l.borrower_name ?? "—"}</span>
          <div className="flex items-center justify-between">
            <span className="font-mono tabular-nums text-slate-500">{money(l.loan_amount)}</span>
            <Signals l={l} />
          </div>
        </div>

        <div className="px-3 pt-2">
          <Block
            title="Total revenue" tone="emerald"
            total={l.revenue} amount={l.loan_amount}
            items={shown(revenue)} loan={l}
          />
          <Block
            title="Total direct costs" tone="rose"
            total={l.costs} amount={l.loan_amount}
            items={shown(costs)} loan={l}
          />
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between bg-[#001A40] p-3 text-xs font-bold text-white shadow-xs">
        <span>NET MARGIN</span>
        <span className="font-mono tabular-nums">
          {fmt(l.net)}
          <span className="ml-1.5 font-normal text-emerald-300">{fmtBps(l.net_bps)} bps</span>
        </span>
      </div>
    </div>
  );
}

function Block({ title, tone, total, amount, items, loan }: {
  title: string; tone: "emerald" | "rose"; total: number; amount: number;
  items: [string, number][]; loan: LoanRow;
}) {
  const badge = tone === "emerald"
    ? "bg-emerald-50 text-emerald-900 border-emerald-200/60"
    : "bg-rose-50 text-rose-900 border-rose-200/60";
  return (
    <>
      <div className={`my-1.5 flex items-center justify-between rounded-lg border px-3 py-1.5 text-xs font-bold ${badge}`}>
        <span className="uppercase tracking-wide">{title}</span>
        <span className="font-mono tabular-nums">
          {fmt(total)}
          <span className="ml-1 font-normal opacity-70">{fmtBps(bpsOf(total, amount))} bps</span>
        </span>
      </div>
      {items.length === 0 && (
        <p className="px-3 pb-1 text-[10px] italic text-slate-400">None</p>
      )}
      {items.map(([concept, v]) => {
        const booked = loan.concept_branches[concept] ?? [];
        // Where the amount is booked, shown only when it is not the loan's own
        // branch — DM Margin lives in 700 for loans every branch originates, and
        // the reader needs to know that without being told it on every line.
        const elsewhere = booked.filter((b) => b !== loan.branch);
        const flagged = loan.unexpected_accounts.includes(concept);
        return (
          <div key={concept} className="flex items-baseline justify-between gap-2 px-3 py-0.5 text-[11px]">
            <span className={`truncate pl-2 ${flagged ? "text-amber-700" : "text-slate-600"}`}>
              {concept}
              {elsewhere.length > 0 && (
                <span title={`Booked in branch ${elsewhere.join(", ")}`} className="ml-1 font-mono text-[9px] text-slate-400">
                  @{elsewhere.join(",")}
                </span>
              )}
              {flagged && (
                <span title="This branch does not normally carry this account." className="ml-1 text-amber-600">!</span>
              )}
            </span>
            <span className={`shrink-0 font-mono tabular-nums text-xs ${num(v)}`}>
              {fmt(v)}
              <span className="ml-1 text-[10px] font-normal text-slate-400">{fmtBps(bpsOf(v, amount))} bps</span>
            </span>
          </div>
        );
      })}
    </>
  );
}

// ─── Shared bits ──────────────────────────────────────────────────────────────

function ViewTab({ active, onClick, icon, label }: {
  active: boolean; onClick: () => void; icon: React.ReactNode; label: string;
}) {
  return (
    <button onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition-colors ${
        active ? "bg-white font-semibold text-[#001A40] shadow-xs" : "text-slate-500 hover:text-[#001A40]"}`}>
      {icon}{label}
    </button>
  );
}

function Signals({ l }: { l: LoanRow }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {l.b2b && <Signal label="B" title="B2B" />}
      {l.support_on_demand && <Signal label="O" title="On Demand" />}
      {l.processing && <Signal label="P" title="Processing" />}
      {l.no_margin && (
        <span className="ml-1 rounded-full border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-[9px] font-bold text-rose-700">
          no margin
        </span>
      )}
      {l.foreign_months.length > 0 && (
        <span title={`Margin posted in ${l.foreign_months.join(", ")}`}
              className="ml-1 rounded-full border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[9px] font-semibold text-sky-800">
          in {l.foreign_months.join(", ")}
        </span>
      )}
    </span>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <th className={`whitespace-nowrap px-2 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-700 ${className}`}>{children}</th>;
}

function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`whitespace-nowrap px-2 py-1.5 text-slate-700 ${className}`}>{children}</td>;
}

function Signal({ label, title }: { label: string; title: string }) {
  return (
    <span title={title}
      className="inline-block h-3.5 w-3.5 rounded-full bg-[#A6DEFF]/50 text-center text-[9px] font-bold leading-[14px] text-[#001A40]">
      {label}
    </span>
  );
}

function Amount({ v, amount, flagged = false, bold = false }: {
  v: number; amount: number; flagged?: boolean; bold?: boolean;
}) {
  return (
    <td className={`whitespace-nowrap px-2 py-1.5 text-right ${flagged ? "bg-amber-50" : ""}`}
        title={flagged ? "This branch does not normally carry this account." : undefined}>
      <span className={`font-mono tabular-nums text-xs ${bold ? "font-bold" : ""} ${num(v)}`}>{fmt(v)}</span>
      {v !== 0 && (
        <span className="ml-1 font-mono text-[10px] font-normal text-slate-400">{fmtBps(bpsOf(v, amount))}</span>
      )}
    </td>
  );
}
