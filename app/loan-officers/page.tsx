"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, LayoutGrid, Rows3, Users } from "lucide-react";
import { ReportFilter } from "@/components/report-filter";
import type { LoPnlPerson, LoPnlResult } from "@/app/api/lo-pnl/route";

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

const fmt = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (v: number) => `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const bps = (v: number | null) => (v == null ? "—" : v.toFixed(1));
const num = (v: number) => (v === 0 ? "text-slate-300" : v < 0 ? "text-rose-600" : "text-[#001A40]");

/**
 * The month before the current one, computed on every load.
 *
 * The same rule the rest of the app uses: December was a constant that quietly
 * became wrong every January.
 */
function previousMonth(): { month: string; year: number } {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return { month: MONTHS[d.getMonth()], year: d.getFullYear() };
}

const BUCKETS = {
  paired: {
    label: "Produced and paid",
    line: "Closings and compensation both located for this person.",
    chip: "bg-emerald-50 text-emerald-800 border-emerald-200",
  },
  producing: {
    label: "Closings, no compensation located",
    line: "They produced. Nothing in the five accounts could be tied to them — which is not the same as being paid nothing.",
    chip: "bg-amber-50 text-amber-800 border-amber-200",
  },
  paid: {
    label: "Paid, no closings",
    line: "Compensation with no loans behind it. Assistants and sales managers belong here; anyone else is the question this page exists to raise.",
    chip: "bg-sky-50 text-sky-900 border-sky-200",
  },
} as const;

export default function LoanOfficersPage() {
  const initial = previousMonth();
  const [months, setMonths] = useState<string[]>([initial.month]);
  const [years, setYears] = useState<string[]>([String(initial.year)]);
  const [view, setView] = useState<"cards" | "table">("table");
  const [data, setData] = useState<LoPnlResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const p = new URLSearchParams([
        ...months.map((m) => ["month", m] as [string, string]),
        ...years.map((y) => ["year", y] as [string, string]),
      ]);
      const res = await fetch(`/api/lo-pnl?${p}`);
      const j = await res.json();
      if (!res.ok) { setError(j.error ?? "Could not load"); setData(null); }
      else setData(j as LoPnlResult);
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }, [months, years]);

  useEffect(() => { load(); }, [load]);

  const groups = useMemo(() => {
    const p = data?.people ?? [];
    return {
      paired: p.filter((x) => x.bucket === "paired"),
      producing: p.filter((x) => x.bucket === "producing").sort((a, b) => b.volume - a.volume),
      paid: p.filter((x) => x.bucket === "paid").sort((a, b) => a.compensation - b.compensation),
    };
  }, [data]);

  const empty = months.length === 0 || years.length === 0;

  return (
    <div className="p-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-[#001A40]">
            <Users size={18} /> Loan Officer P&amp;L
          </h1>
          <p className="mt-1 max-w-3xl text-xs text-slate-500">
            What each loan officer produced against what they were paid. Compensation is
            the five accounts named at the foot of the page — payroll taxes and insurance
            are <span className="font-semibold text-slate-700">not</span> included, and the
            amount left out is shown there rather than left to be assumed.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ReportFilter label="Month" options={MONTHS} selected={months} onChange={setMonths} />
          <ReportFilter label="Year" options={["2025", "2026"]} selected={years} onChange={setYears} />
          <div className="flex items-center gap-1 rounded-full bg-slate-100 p-1">
            <button onClick={() => setView("table")}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${view === "table" ? "bg-white text-[#001A40] shadow-xs" : "text-slate-500"}`}>
              <Rows3 size={12} /> Table
            </button>
            <button onClick={() => setView("cards")}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${view === "cards" ? "bg-white text-[#001A40] shadow-xs" : "text-slate-500"}`}>
              <LayoutGrid size={12} /> Mini P&amp;L Cards
            </button>
          </div>
        </div>
      </div>

      {empty && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-medium text-amber-900">
          Pick at least one month and one year — with neither, this page would be reporting on nothing.
        </p>
      )}
      {loading && <p className="py-10 text-center text-sm text-slate-400">Loading…</p>}
      {error && <p className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-xs text-red-600">{error}</p>}

      {data && !loading && !empty && (
        <>
          {/* The alias table is optional. Saying it is absent beats letting two
              people sit unexplained in the amber bucket. */}
          {!data.aliases_available && (
            <p className="mb-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-[11px] text-slate-600">
              The confirmed-equivalences table has not been created yet, so every pairing below
              comes from the name rule alone. Names it cannot settle stay in
              <span className="font-semibold"> Closings, no compensation located</span>.
            </p>
          )}
          {data.undecided.length > 0 && (
            <p className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-[11px] text-amber-900">
              <AlertTriangle size={12} className="mr-1 inline" />
              {data.undecided.length} name{data.undecided.length === 1 ? "" : "s"} could not be settled and
              {" "}<span className="font-semibold">were not guessed at</span>: {data.undecided.join(", ")}.
              {" "}Each matches a payroll person that another officer matches too, so neither was given the pay — had one
              been picked, the totals below would have counted it twice.
              {" "}These are one person written two ways in the loan file, one spelling carrying almost every closing and
              the other exactly one. That typo splits the <span className="font-semibold">closings</span> anywhere the app
              groups by officer, not just the pay here, so it is corrected at the source rather than paired off — an
              equivalence would settle this screen and leave every other one counting two people.
            </p>
          )}

          {view === "table" ? (
            <div className="space-y-5">
              {(["paired", "producing", "paid"] as const).map((b) => (
                <BucketTable key={b} bucket={b} rows={groups[b]} />
              ))}
            </div>
          ) : (
            <div className="space-y-5">
              {(["paired", "producing", "paid"] as const).map((b) => (
                <section key={b}>
                  <BucketHeading bucket={b} n={groups[b].length} />
                  <div className="scrollbar-thin-slate flex flex-row gap-4 overflow-x-auto pb-3">
                    {groups[b].map((p) => <MiniCard key={p.name} p={p} />)}
                    {groups[b].length === 0 && <p className="py-6 text-xs italic text-slate-400">Nobody in this period.</p>}
                  </div>
                </section>
              ))}
            </div>
          )}

          <ControlFooter data={data} />
        </>
      )}
    </div>
  );
}

function BucketHeading({ bucket, n }: { bucket: keyof typeof BUCKETS; n: number }) {
  const b = BUCKETS[bucket];
  return (
    <div className="mb-2 flex flex-wrap items-baseline gap-2">
      <span className={`rounded-full border px-2.5 py-1 text-[11px] font-bold ${b.chip}`}>
        {b.label} · {n}
      </span>
      <span className="text-[11px] text-slate-500">{b.line}</span>
    </div>
  );
}

function BucketTable({ bucket, rows }: { bucket: keyof typeof BUCKETS; rows: LoPnlPerson[] }) {
  const t = {
    volume: rows.reduce((s, r) => s + r.volume, 0),
    revenue: rows.reduce((s, r) => s + r.revenue, 0),
    comp: rows.reduce((s, r) => s + r.compensation, 0),
    net: rows.reduce((s, r) => s + r.net, 0),
  };
  return (
    <section>
      <BucketHeading bucket={bucket} n={rows.length} />
      {rows.length === 0 ? (
        <p className="rounded-xl border border-slate-200 bg-white px-4 py-6 text-center text-xs italic text-slate-400">
          Nobody in this period.
        </p>
      ) : (
        <div className="overflow-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full border-collapse text-xs">
            <thead className="bg-slate-100/95">
              <tr className="border-b-2 border-slate-200 text-left text-slate-600">
                <Th>Person</Th>
                <Th className="text-center">Br</Th>
                <Th className="text-right">Closings</Th>
                <Th className="text-right">Volume</Th>
                <Th className="text-right">Revenue</Th>
                <Th className="text-right">Compensation</Th>
                <Th className="text-right bg-[#A6DEFF]/20">Net</Th>
                <Th className="text-right bg-[#A6DEFF]/20">Net bps</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p, i) => (
                <tr key={p.name} className="border-b border-slate-200/60 hover:bg-[#A6DEFF]/25"
                    style={{ backgroundColor: i % 2 ? "#fcfdfe" : "#ffffff" }}>
                  <Td>
                    <span className="font-medium text-slate-800">{p.name}</span>
                    {p.via_alias && (
                      <span title="Paired through a confirmed equivalence, not by the name rule."
                            className="ml-1.5 rounded bg-slate-100 px-1 py-0.5 text-[9px] font-semibold text-slate-500">alias</span>
                    )}
                    {p.payroll_name && p.payroll_name !== p.name && (
                      <span className="ml-1.5 font-mono text-[10px] text-slate-400">{p.payroll_name}</span>
                    )}
                  </Td>
                  <Td className="text-center font-mono text-[10px] text-slate-500">{p.branches.join(" ") || "—"}</Td>
                  <Td className="text-right font-mono tabular-nums">{p.closings || "—"}</Td>
                  <Td className="text-right font-mono tabular-nums">{p.volume ? money(p.volume) : "—"}</Td>
                  <Td className={`text-right font-mono tabular-nums ${num(p.revenue)}`}>{p.revenue ? fmt(p.revenue) : "—"}</Td>
                  <Td className="text-right font-mono tabular-nums">
                    {/* A dash and a reason, never a zero. A zero here would say
                        "this person was paid nothing", which is a claim the data
                        does not support. */}
                    {p.bucket === "producing"
                      ? <span title={p.unpaid_reason === "undecided_match"
                          ? "Their name matches more than one person in the payroll, or is shared with another officer. Not guessed at."
                          : "No row in the five compensation accounts carries this surname."}
                          className="text-amber-700">not located</span>
                      : <span className={num(p.compensation)}>{fmt(p.compensation)}</span>}
                  </Td>
                  <Td className={`text-right font-mono font-bold tabular-nums ${num(p.net)}`}>{fmt(p.net)}</Td>
                  <Td className={`text-right font-mono tabular-nums ${num(p.net)}`}>{bps(p.net_bps)}</Td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-[#001A40]/20 bg-[#001A40]/5 font-bold">
                <Td className="text-[#001A40]">{rows.length} {rows.length === 1 ? "person" : "people"}</Td>
                <Td />
                <Td className="text-right font-mono tabular-nums">{rows.reduce((s, r) => s + r.closings, 0) || "—"}</Td>
                <Td className="text-right font-mono tabular-nums">{t.volume ? money(t.volume) : "—"}</Td>
                <Td className={`text-right font-mono tabular-nums ${num(t.revenue)}`}>{fmt(t.revenue)}</Td>
                <Td className={`text-right font-mono tabular-nums ${num(t.comp)}`}>{fmt(t.comp)}</Td>
                <Td className={`text-right font-mono tabular-nums ${num(t.net)}`}>{fmt(t.net)}</Td>
                <Td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}

function MiniCard({ p }: { p: LoPnlPerson }) {
  const concepts = Object.entries(p.concepts).filter(([, v]) => v !== 0).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const comp = Object.entries(p.comp_by_account).filter(([, v]) => v !== 0).sort((a, b) => a[1] - b[1]);
  return (
    <div className="flex w-[320px] shrink-0 flex-col justify-between overflow-hidden rounded-2xl border border-slate-200/90 bg-white shadow-xs">
      <div>
        <div className="flex flex-col gap-1 border-b border-slate-200 bg-slate-100/90 p-3.5 text-xs font-bold text-[#001A40]">
          <span className="truncate">{p.name}</span>
          <span className="truncate text-[10px] font-normal text-slate-500">
            {p.closings ? `${p.closings} closing${p.closings === 1 ? "" : "s"} · ${money(p.volume)}` : "no closings"}
            {p.branches.length > 0 && ` · ${p.branches.join(" ")}`}
          </span>
        </div>

        <div className="px-3 pt-2">
          <Band title="Revenue" total={p.revenue} tone="emerald" />
          {concepts.length === 0 && <p className="px-3 pb-1 text-[10px] italic text-slate-400">None</p>}
          {concepts.map(([k, v]) => <Line key={k} label={k} v={v} />)}

          <Band title="Compensation" total={p.compensation} tone="rose" />
          {p.bucket === "producing" ? (
            <p className="px-3 pb-1 text-[10px] italic text-amber-700">
              Not located in the five accounts — not the same as zero.
            </p>
          ) : comp.length === 0 ? (
            <p className="px-3 pb-1 text-[10px] italic text-slate-400">None</p>
          ) : comp.map(([k, v]) => <Line key={k} label={k} v={v} />)}
        </div>
      </div>

      <div className={`mt-2 flex items-baseline justify-between px-3.5 py-2.5 text-xs font-bold ${p.net < 0 ? "bg-rose-50 text-rose-700" : "bg-[#001A40]/5 text-[#001A40]"}`}>
        <span className="uppercase tracking-wide">Net</span>
        <span className="font-mono tabular-nums">
          {fmt(p.net)}
          {p.net_bps != null && <span className="ml-1.5 font-normal opacity-70">{bps(p.net_bps)} bps</span>}
        </span>
      </div>
    </div>
  );
}

function Band({ title, total, tone }: { title: string; total: number; tone: "emerald" | "rose" }) {
  const cls = tone === "emerald"
    ? "bg-emerald-50 text-emerald-900 border-emerald-200/60"
    : "bg-rose-50 text-rose-900 border-rose-200/60";
  return (
    <div className={`my-1.5 flex items-center justify-between rounded-lg border px-3 py-1.5 text-xs font-bold ${cls}`}>
      <span className="uppercase tracking-wide">{title}</span>
      <span className="font-mono tabular-nums">{fmt(total)}</span>
    </div>
  );
}

function Line({ label, v }: { label: string; v: number }) {
  return (
    <div className="flex items-baseline justify-between gap-2 px-3 py-0.5 text-[11px]">
      <span className="truncate text-slate-600">{label}</span>
      <span className={`shrink-0 font-mono tabular-nums ${num(v)}`}>{fmt(v)}</span>
    </div>
  );
}

/**
 * The check, shown rather than asserted.
 *
 * Three buckets plus the rows that carry no name have to add up to what the five
 * accounts hold. Printing the sum is what caught a double count — one person
 * written two ways in loan_officials, claimed by both spellings.
 */
function ControlFooter({ data }: { data: LoPnlResult }) {
  const c = data.control;
  const ok = Math.abs(c.difference) < 0.005;
  return (
    <div className="mt-6 rounded-xl border border-slate-200 bg-white p-4 text-[11px]">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-xs font-bold text-[#001A40]">Control total</span>
        <span className={`rounded-full px-2.5 py-1 font-semibold ${ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-700"}`}>
          {ok ? "The buckets add up to the ledger" : `Off by ${fmt(c.difference)} — do not trust the figures above`}
        </span>
      </div>

      <table className="mt-3 w-full max-w-xl text-[11px]">
        <tbody className="[&_td]:py-0.5">
          <tr><td className="text-slate-600">Produced and paid</td>
              <td className="text-right font-mono tabular-nums">{fmt(data.totals.compensation_paired)}</td></tr>
          <tr><td className="text-slate-600">Paid, no closings</td>
              <td className="text-right font-mono tabular-nums">{fmt(data.totals.compensation_paid)}</td></tr>
          <tr><td className="text-slate-600">
                Rows with no name{c.unnamed_rows > 0 && <span className="text-slate-400"> · {c.unnamed_rows} row{c.unnamed_rows === 1 ? "" : "s"}</span>}
              </td>
              <td className="text-right font-mono tabular-nums">{fmt(c.unnamed_total)}</td></tr>
          <tr className="border-t border-slate-200 font-semibold">
              <td className="pt-1 text-[#001A40]">The five accounts</td>
              <td className="pt-1 text-right font-mono tabular-nums">{fmt(c.accounts_total)}</td></tr>
        </tbody>
      </table>

      <p className="mt-3 text-slate-500">
        Compensation counted here: {Object.entries(c.accounts).map(([g, n]) => `${g} ${n}`).join(" · ")}.
      </p>
      <p className="mt-1.5 text-slate-500">
        {/* Said, not omitted. A cost side that quietly excludes a third of the
            money reads as a complete cost side. */}
        <span className="font-semibold text-slate-700">Left out: {fmt(data.excluded.total)}</span> across{" "}
        {data.excluded.rows} rows of {Object.values(data.excluded.accounts).join(", ")}. Under half of it can be
        tied to a named person, and the half that can depends on names the ledger truncates at 35 characters,
        which is where two people become one. Adding it would make this page more wrong, not more complete.
      </p>
    </div>
  );
}

function Th({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return <th className={`px-3 py-2 text-[10px] font-bold uppercase tracking-wider ${className}`}>{children}</th>;
}
function Td({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-1.5 ${className}`}>{children}</td>;
}
