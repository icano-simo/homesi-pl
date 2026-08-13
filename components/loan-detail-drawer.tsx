"use client";

import { useEffect, useMemo, useState } from "react";
import { X, ArrowUpDown } from "lucide-react";
import {
  ALL_MARGIN_ACCOUNTS,
  NON_NET_GROUPS,
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
  year: number | null;
  branches: string[];
  sources: string[];
  onClose: () => void;
}

const fmt = (v: number) =>
  v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtBps = (v: number | null) => (v == null ? "—" : v.toFixed(1));
const money = (v: number) => `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

const num = (v: number) =>
  v === 0 ? "text-slate-300 font-normal" : v < 0 ? "text-rose-600" : "text-[#001A40]";

export function LoanDetailDrawer({ open, month, year, branches, sources, onClose }: Props) {
  const [data, setData]       = useState<DetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState("");
  const [showOther, setShowOther] = useState(false);
  const [sortDesc, setSortDesc]   = useState(true);

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

  /**
   * Margin columns for this window.
   *
   * The expected set for the branches in view, plus any account that actually
   * carries an amount somewhere — appended, flagged amber, never dropped.
   */
  const { expected, extra, otherConcepts } = useMemo(() => {
    const loans = data?.loans ?? [];
    const branchSet = new Set(loans.map((l) => l.branch));
    // A window can span branches. Union of what each of them is expected to have.
    const exp: string[] = [];
    for (const b of branchSet) for (const a of expectedMarginAccounts(b)) if (!exp.includes(a)) exp.push(a);
    const ext = ALL_MARGIN_ACCOUNTS.filter(
      (a) => !exp.includes(a) && loans.some((l) => (l.concepts[a] ?? 0) !== 0),
    );
    const others = [
      ...new Set(loans.flatMap((l) => Object.keys(l.concepts))),
    ].filter((c) => !ALL_MARGIN_ACCOUNTS.includes(c)).sort();
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
        className="fixed inset-y-0 right-0 z-50 flex h-full w-full max-w-[1100px] flex-col border-l border-slate-200 bg-white shadow-2xl"
      >
        <div className="border-b border-slate-200 px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-bold text-[#001A40]">
                Loans · {month} {year}
              </h2>
              {/* The base is not the one used in the P&L grid. Saying so here is
                  the whole reason this line exists: 300 bps against a loan and
                  300 bps against a month's volume are unrelated numbers. */}
              <p className="mt-1 text-[11px] text-slate-500">
                bps divide by <span className="font-semibold text-[#001A40]">each loan&apos;s own amount</span>,
                not the monthly loan volume used in the P&amp;L grid.
              </p>
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="shrink-0 rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            >
              <X size={16} />
            </button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              onClick={() => setShowOther((v) => !v)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                showOther
                  ? "border-sky-200 bg-sky-50 text-sky-900"
                  : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50"
              }`}
            >
              {showOther ? "Hide other concepts" : "Show other concepts"}
            </button>
            <button
              onClick={() => setSortDesc((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 hover:border-slate-300"
            >
              <ArrowUpDown size={11} />
              Net bps {sortDesc ? "high → low" : "low → high"}
            </button>
            <span className="rounded-full border border-slate-200 bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-500">
              Net = {(data?.net_groups ?? []).join(" + ")}
            </span>
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          {loading && <p className="p-5 text-sm text-slate-400">Loading…</p>}
          {error && <p className="m-5 rounded-xl border border-red-100 bg-red-50 px-4 py-2 text-xs text-red-600">{error}</p>}

          {data && !loading && (
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 z-10 bg-slate-100/95">
                <tr className="border-b-2 border-slate-200 text-left">
                  <Th>Loan</Th>
                  <Th>Borrower</Th>
                  <Th>Officer</Th>
                  <Th className="text-center">Br</Th>
                  <Th>Program</Th>
                  <Th className="text-right">Amount</Th>
                  {marginCols.map((c) => (
                    <Th
                      key={c}
                      className={`text-right ${extra.includes(c) ? "bg-amber-50 text-amber-800" : ""}`}
                      title={extra.includes(c)
                        ? `${c} is not an account these branches normally carry. Shown because loans here have an amount in it.`
                        : undefined}
                    >
                      {c}
                    </Th>
                  ))}
                  {showOther && otherConcepts.map((c) => (
                    <Th key={c} className="text-right bg-slate-50">{c}</Th>
                  ))}
                  <Th className="text-right">Costs</Th>
                  <Th className="text-right">Net</Th>
                  <Th className="text-right">Net bps</Th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((l, i) => (
                  <tr
                    key={l.loan_number}
                    className="border-b border-slate-200/60 hover:bg-[#A6DEFF]/25"
                    style={{ backgroundColor: i % 2 ? "#fcfdfe" : "#ffffff" }}
                  >
                    <Td className="font-mono">
                      {l.loan_number}
                      <span className="ml-1.5 inline-flex gap-0.5">
                        {l.b2b && <Signal label="B" title="B2B" />}
                        {l.support_on_demand && <Signal label="O" title="On Demand" />}
                        {l.processing && <Signal label="P" title="Processing" />}
                      </span>
                      {l.no_margin && (
                        <span className="ml-1.5 rounded-full border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-[9px] font-bold text-rose-700">
                          no margin
                        </span>
                      )}
                      {l.foreign_months.length > 0 && (
                        <span
                          title={`Margin posted in ${l.foreign_months.join(", ")}`}
                          className="ml-1.5 rounded-full border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[9px] font-semibold text-sky-800"
                        >
                          in {l.foreign_months.join(", ")}
                        </span>
                      )}
                    </Td>
                    <Td className="max-w-[160px] truncate">{l.borrower_name ?? "—"}</Td>
                    <Td className="max-w-[140px] truncate">{l.loan_officer ?? "—"}</Td>
                    <Td className="text-center font-mono">{l.branch}</Td>
                    <Td className="max-w-[110px] truncate">{l.loan_program ?? "—"}</Td>
                    <Td className="text-right tabular-nums">{money(l.loan_amount)}</Td>
                    {marginCols.map((c) => (
                      <Amount
                        key={c}
                        v={l.concepts[c] ?? 0}
                        amount={l.loan_amount}
                        flagged={l.unexpected_accounts.includes(c)}
                      />
                    ))}
                    {showOther && otherConcepts.map((c) => (
                      <Amount key={c} v={l.concepts[c] ?? 0} amount={l.loan_amount} />
                    ))}
                    <Amount v={l.costs} amount={l.loan_amount} />
                    <Amount v={l.net} amount={l.loan_amount} bold />
                    <Td className={`text-right font-mono tabular-nums font-bold ${num(l.net)}`}>
                      {fmtBps(l.net_bps)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {data && !loading && data.orphans.length > 0 && (
            <details className="m-5 rounded-xl border border-slate-200 bg-slate-50">
              <summary className="cursor-pointer px-4 py-2.5 text-xs font-semibold text-slate-700">
                Not in the master loan list — {data.orphans.length} loan
                {data.orphans.length > 1 ? "s" : ""} · {money(data.orphans_total)}
              </summary>
              <table className="w-full border-collapse text-xs">
                <tbody>
                  {data.orphans.map((o) => (
                    <tr key={o.loan_number} className="border-t border-slate-200/60">
                      <Td className="font-mono">{o.loan_number}</Td>
                      <Td className="text-center font-mono">{o.branch ?? "—"}</Td>
                      <Td className="text-right tabular-nums">{fmt(o.total)}</Td>
                      {/* No loan amount, so no denominator and no bps. */}
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

function Th({ children, className = "", title }: { children: React.ReactNode; className?: string; title?: string }) {
  return (
    <th title={title} className={`whitespace-nowrap px-2 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-700 ${className}`}>
      {children}
    </th>
  );
}

function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`whitespace-nowrap px-2 py-1.5 text-slate-700 ${className}`}>{children}</td>;
}

function Signal({ label, title }: { label: string; title: string }) {
  return (
    <span
      title={title}
      className="inline-block h-3.5 w-3.5 rounded-full bg-[#A6DEFF]/50 text-center text-[9px] font-bold leading-[14px] text-[#001A40]"
    >
      {label}
    </span>
  );
}

function Amount({ v, amount, flagged = false, bold = false }: {
  v: number; amount: number; flagged?: boolean; bold?: boolean;
}) {
  const b = amount ? (v / amount) * 10000 : null;
  return (
    <td
      className={`whitespace-nowrap px-2 py-1.5 text-right ${flagged ? "bg-amber-50" : ""}`}
      title={flagged ? "This branch does not normally carry this account." : undefined}
    >
      <span className={`font-mono tabular-nums ${bold ? "font-bold" : ""} ${num(v)}`}>{fmt(v)}</span>
      {v !== 0 && (
        <span className="ml-1 font-mono text-[10px] text-slate-400">{b == null ? "—" : b.toFixed(1)}</span>
      )}
    </td>
  );
}

/** Groups deliberately outside the net, listed for the caller's reference. */
export const NET_EXCLUDED_GROUPS = NON_NET_GROUPS;
