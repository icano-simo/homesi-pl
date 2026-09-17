"use client";

import { useEffect, useMemo, useState } from "react";
import { X, ArrowUpDown, LayoutGrid, Rows3, UserCircle } from "lucide-react";
import { ReportFilter } from "@/components/report-filter";
import { LoPnlView } from "@/components/lo-pnl-view";
import type { AffinityLens } from "@/lib/loan-branch";
import { LoanPnlCard } from "@/components/loan-pnl-card";
import {
  ALL_MARGIN_ACCOUNTS,
  NET_GROUPS,
  conceptLabel,
  expectedMarginAccounts,
} from "@/lib/loan-detail-accounts";

interface LoanLine {
  gl_code: string;
  gl_name: string;
  category_7: string;
  /** El grupo contable: reparte la linea en su peldaño. */
  category_6: string | null;
  /** La sucursal del apunte. Null en el resumen, que suma varias. */
  branch: string | null;
  amount: number;
}

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
  lines: LoanLine[];
  concept_branches: Record<string, string[]>;
  unexpected_accounts: string[];
  foreign_months: string[];
  revenue: number;
  costs: number;
  net: number;
  net_bps: number | null;
  /** De comp.loan_commission. Null = no cruza, que NO es cero. */
  commission: number | null;
  /** net - commission. Null cuando la comision no se conoce. */
  contribution: number | null;
  contribution_bps: number | null;
  /** Su mes no tiene P&L cargado: la contribucion sale negativa por eso. */
  pl_pending: boolean;
  no_margin: boolean;
  /** Every margin account, and only margin. See margin_net in the endpoint. */
  margin_net: number;
}

interface Summary {
  loan_count: number;
  volume: number;
  without_margin: number;
  banked_only: boolean;
  concepts: Record<string, number>;
  lines: LoanLine[];
  revenue: number;
  costs: number;
  net: number;
  net_bps: number | null;
  commission: number;
  loans_without_commission: number;
  contribution: number;
  contribution_bps: number | null;
}

interface DetailData {
  month: string;
  year: number;
  loans: LoanRow[];
  summary: Summary;
  branch_filter: string[];
  missing:      StrayBucket;
  other_period: StrayBucket;
  out_of_scope: StrayBucket;
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
  /** La lente de Affinity, elegida en la pantalla del P&L. */
  lente?: AffinityLens;
  sources: string[];
  onClose: () => void;
}

const fmt   = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (v: number) => `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const bpsOf = (v: number, amount: number) => (amount ? (v / amount) * 10000 : null);
const fmtBps = (v: number | null) => (v == null ? "—" : v.toFixed(1));

const num = (v: number) =>
  v === 0 ? "text-slate-300 font-normal" : v < 0 ? "text-rose-600" : "text-[#001A40]";

/**
 * Que hay dentro de "Other revenue", CUENTA POR CUENTA Y CON SU NUMERO.
 *
 * El gl_code y no solo el nombre, porque es lo unico que permite cuadrar esto
 * contra la contabilidad. Y porque ahi dentro hay cuentas que nadie espera:
 * 55275 Processing Fees, 55276 Loan Setup y 55277 LPP son del rango 55xxx --
 * costes-- y viven en `category_6 = 'Revenue'`. Son los "otros costos" que se
 * veian sin poder senalarlos: -23.005,00 en total.
 *
 * Se lee de `lines`, que ya viene desglosado por gl_code, en vez de de
 * `concepts`, que agrupa por category_7 y perderia justo el numero de cuenta.
 */
function otherRevenueDetail(l: LoanRow): string {
  const rest = l.lines.filter((ln) => !ALL_MARGIN_ACCOUNTS.includes(ln.category_7));
  if (rest.length === 0) return "No other revenue on this loan";
  return rest
    .map((ln) => `${ln.gl_code} ${ln.gl_name}  ${fmt(ln.amount)}`)
    .join("\n");
}

/**
 * Item colour, from the effect on the net and nothing else. Same rule in both
 * blocks.
 *
 *   movement > 0  →  adds to the net    (income, or a credit in an expense
 *                                        account: a refund)
 *   movement < 0  →  takes from the net (a real expense, or a margin clawback)
 *
 * An earlier version made this depend on the block, on the idea that a negative
 * under Costs was a refund. It is the opposite: loan 707002013216 carries
 * Compensation Transfers at debit 32,144.00, movement -32,144.00 — a real
 * $32k expense that reduces the net. In green it would have read as good news.
 *
 * The sign alone cannot separate "real expense" from "margin clawback", and it
 * does not try to. That distinction lives in the tooltip. Colour answers one
 * question — does this push the net up or down — because that is what gets read
 * at a glance.
 */
function itemCls(v: number): string {
  if (v === 0) return "text-slate-300 font-normal";
  return v < 0 ? "text-rose-600 font-medium" : "text-slate-800";
}

/** What the sign does here, spelled out for the tooltip. */
function signHint(v: number): string {
  if (v === 0) return "No amount";
  return v > 0 ? "Adds to the net" : "Takes from the net";
}

export function LoanDetailDrawer({ open, month, year, branches, sources, lente = "ambas", onClose }: Props) {
  const [data, setData]       = useState<DetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState("");
  const [sortDesc, setSortDesc]   = useState(true);
  const [view, setView] = useState<"cards" | "table" | "officers">("cards");
  /**
   * Branch filter inside the window, over the branch each loan was produced on.
   *
   * Its purpose is the question the window could not answer: what revenue do
   * 716's loans leave in 700's books. It narrows the cards, the table, the
   * columns and the totals row together — a filter that moved the rows and left
   * the footer alone is the bug this branch has already fixed three times.
   */
  const [branchFilter, setBranchFilter] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  /* ⚠ LA LENTE VA EN LA CLAVE. Es la cuarta vez en esta pantalla que el mismo
     olvido tiene el mismo sintoma: el control se marca y los datos no cambian. */
  const key = `${month}|${year}|${branches.join(",")}|${sources.join(",")}|${lente}`;

  useEffect(() => {
    if (!open || !month || !year) return;
    const p = new URLSearchParams({ month, year: String(year) });
    branches.forEach((b) => p.append("branch", b));
    sources.forEach((s) => p.append("source", s));
    if (lente !== "ambas") p.append("lens", lente);

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

  const branchOptions = useMemo(
    () => [...new Set((data?.loans ?? []).map((l) => l.branch))].sort(),
    [data],
  );

  /** The loans in scope: what the filter leaves, and what everything else reads. */
  const inScope = useMemo(
    () => (branchFilter.length
      ? (data?.loans ?? []).filter((l) => branchFilter.includes(l.branch))
      : (data?.loans ?? [])),
    [data, branchFilter],
  );

  /**
   * Only the margin columns that carry a value in the active scope.
   *
   * It used to be a fixed list per branch — expectedMarginAccounts — plus the
   * ones outside it that happened to be non-zero. So looking at 700 always drew
   * Back-end, Front-end and Discount, which in most of its months are empty.
   *
   * Derived from the data instead, with no threshold: in 10 of the 700's 11
   * months that leaves DM and RM alone, and in February 2026 it draws all five,
   * because there really is 8.763,33 of Back-end there. Hiding it would be
   * hiding money.
   *
   * The amber styling stays for accounts the branch is not expected to earn
   * through — that is signal, not decoration.
   */
  const { marginCols, extra, otherConcepts } = useMemo(() => {
    const branchSet = new Set(inScope.map((l) => l.branch));
    const exp = new Set<string>();
    for (const b of branchSet) for (const a of expectedMarginAccounts(b)) exp.add(a);
    const present = ALL_MARGIN_ACCOUNTS.filter(
      (a) => inScope.some((l) => (l.concepts[a] ?? 0) !== 0),
    );
    const others = [...new Set(inScope.flatMap((l) => Object.keys(l.concepts)))]
      .filter((c) => !ALL_MARGIN_ACCOUNTS.includes(c)).sort();
    return { marginCols: present, extra: present.filter((a) => !exp.has(a)), otherConcepts: others };
  }, [inScope]);

  /**
   * Totals over the rows on screen, not over everything the server sent.
   *
   * The server's summary describes the unfiltered month, so with a branch filter
   * on it would be answering a different question from the table above it.
   */
  const totals = useMemo(() => {
    const volume = inScope.reduce((s, l) => s + l.loan_amount, 0);
    const concepts: Record<string, number> = {};
    for (const l of inScope) for (const [k, v] of Object.entries(l.concepts)) concepts[k] = (concepts[k] ?? 0) + v;
    const net = inScope.reduce((s, l) => s + l.net, 0);
    const marginNet = inScope.reduce((s, l) => s + l.margin_net, 0);
    // Solo las comisiones conocidas. Un null contado como cero diria que ese
    // prestamo no le costo nada a la sucursal.
    const commission = inScope.reduce((s, l) => s + (l.commission ?? 0), 0);
    const contribution = net - commission;
    return {
      loan_count: inScope.length,
      without_margin: inScope.filter((l) => l.no_margin).length,
      volume, concepts, net, marginNet, commission, contribution,
      net_bps:    volume ? (net / volume) * 10000 : null,
      margin_bps: volume ? (marginNet / volume) * 10000 : null,
      contribution_bps: volume ? (contribution / volume) * 10000 : null,
    };
  }, [inScope]);

  /**
   * The period carries no loan program at all — not "this loan has none".
   *
   * One missing program is a gap in a record; every program missing is a column
   * absent from the file that was loaded, and the two need different words. The
   * test is over what the server sent, not over the branch filter, because a
   * filter narrowing to loans that happen to lack it does not make the file
   * incomplete.
   */
  const noProgramAtAll = useMemo(
    () => !!data?.loans.length && data.loans.every((l) => !l.loan_program?.trim()),
    [data],
  );

  const sorted = useMemo(() => {
    const rows = [...inScope];
    rows.sort((a, b) => {
      const av = a.net_bps ?? -Infinity, bv = b.net_bps ?? -Infinity;
      return sortDesc ? bv - av : av - bv;
    });
    return rows;
  }, [inScope, sortDesc]);

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-slate-900/20" onClick={onClose} />
      <div
        role="dialog"
        aria-label="Loan detail"
        className="fixed inset-y-0 right-0 z-50 flex h-full w-full max-w-7xl flex-col border-l border-slate-200 bg-white shadow-2xl"
      >
        <div className="border-b border-slate-200 px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-bold text-[#001A40]">
                Loans · {month} {year ?? ""}
              </h2>
              <p className="mt-1 text-[11px] text-slate-500">
                {/* Said before any figure. The volume here is not the month's
                    volume, and a reader who assumes it is will draw the wrong
                    conclusion from every bps below. */}
                <span className="font-semibold text-[#001A40]">Banked loans only.</span>{" "}
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
              {/*
                * ⚠ AQUI Y NO EN UNA PANTALLA APARTE, porque es donde se trabaja.
                * El modulo existe tambien en /lo-pnl, pero la pregunta "¿quien
                * de MI sucursal se paga solo?" se hace mirando el P&L de la
                * sucursal, no navegando a otro sitio.
                *
                * Comparte el calculo con la pantalla propia -- un solo
                * componente, LoPnlView. Dos copias serian dos definiciones de
                * "cuanto produce esta persona" separandose sin que nada falle.
                */}
              <ViewTab active={view === "officers"} onClick={() => setView("officers")} icon={<UserCircle size={12} />} label="P&L by Loan Officer" />
            </div>
            {branchOptions.length > 1 && (
              <ReportFilter label="Branch" options={branchOptions}
                            selected={branchFilter} onChange={setBranchFilter} />
            )}
            {branchFilter.length > 0 && (
              <span className="rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-[11px] font-medium text-sky-900">
                {totals.loan_count} of {data?.loans.length ?? 0} loans
              </span>
            )}
            <button onClick={() => setSortDesc((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 hover:border-slate-300">
              <ArrowUpDown size={11} />
              Net bps {sortDesc ? "high → low" : "low → high"}
            </button>
            {/*
              * ⚠ LA NOTA DE COMPENSAFE, UNA SOLA VEZ Y AQUI. Estaba repetida en
              * cada tarjeta del mini P&L: con sesenta y cinco en la fila deja de
              * leerse y ocupa el sitio del dato. Dicha en la definicion del
              * total vale para toda la pantalla, que es su alcance real.
              */}
            <span className="rounded-full border border-slate-200 bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-500"
                  title="The commission comes from Compensafe, not from the P&L: it has no GL account and cannot be reconciled against the ledger like the rest of the card.">
              Contribution = {(data?.net_groups ?? NET_GROUPS).join(" + ")} − LO commission
              <span className="ml-1.5 font-normal text-slate-400">from Compensafe, not a P&amp;L account</span>
            </span>
            {/* A whole column of dashes reads as a broken column, and that is
                how this one was reported. It is not broken: July 2026 is the
                only period whose file arrived without the program column, so
                all 48 of its banked loans have nothing to show. Every other
                period carries it on 100% of loans. Said here rather than left
                for the reader to infer from a column of "—". */}
            {noProgramAtAll && (
              <span title="The source file for this period has no loan program column. Every other period carries it on every loan."
                    className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800">
                No loan program in this period&apos;s file
              </span>
            )}
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
            <div className="scrollbar-thin-slate flex max-w-full flex-row items-stretch gap-4 overflow-x-auto p-4 pb-6">
              {data.summary.loan_count > 0 && (
                <SummaryCard s={data.summary} month={data.month} />
              )}
              {sorted.map((l) => <MiniPL key={l.loan_number} l={l} />)}
            </div>
          )}

          {view === "officers" && (
            /*
              * ⚠ LA SUCURSAL SALE DEL INFORME, Y EL FILTRO DE DENTRO SOLO LA
              * ESTRECHA. Miraba SOLO `branchFilter` -- el filtro de dentro del
              * modal, que arranca vacio-- asi que abrir el P&L de la 716 y
              * pulsar la pestaña daba `branch = null`: la vista de todas las
              * sucursales, dentro de la ventana de una.
              *
              * `branches` es lo que el informe ya tiene acotado cuando se abre
              * la ventana. Con varias seleccionadas por cualquiera de los dos
              * lados se enseñan todas: "los loan officers de estas tres
              * sucursales" no es una pregunta que esta tabla conteste bien, y
              * quedarse con la primera seria elegir por el usuario en silencio.
              */
            <div className="px-1 py-2">
              <LoPnlView
                branch={
                  branchFilter.length === 1 ? branchFilter[0]
                    : branchFilter.length === 0 && branches.length === 1 ? branches[0]
                    : null
                }
                month={data?.month ?? month}
                year={data?.year ?? year}
                /*
                 * ⚠ SIN ESTO LA PESTAÑA SE QUEDA EN "ambas" Y NADIE SE ENTERA.
                 * Falto en la primera version: el drawer recibia `lente` y no
                 * se la pasaba, asi que con Affinity puesto esta pestaña seguia
                 * enseñando los 15 officers de la 716 en vez de solo Nathan.
                 *
                 * Y NO LO CAZO EL COMPILADOR, que es lo que lo hizo durar: el
                 * prop es opcional con defecto "ambas" --para que las pantallas
                 * que no conocen la lente no cambien-- y ese mismo defecto
                 * convierte olvidarlo en algo que compila y se ve razonable.
                 */
                lente={lente}
              />
            </div>
          )}

          {data && !loading && view === "table" && (
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 z-10 bg-slate-100/95">
                <tr className="border-b-2 border-slate-200 text-left">
                  <Th>Loan</Th><Th>Borrower</Th><Th>Program</Th><Th className="text-center">Br</Th>
                  <Th className="text-right">Amount</Th>
                  {marginCols.map((c) => (
                    <Th key={c} className={`text-right ${extra.includes(c) ? "bg-amber-50 text-amber-800" : ""}`}>{c}</Th>
                  ))}
                  {/* ── LA RESTA SE CIERRA DE IZQUIERDA A DERECHA ────────────
                      Margin + Other revenue = Total revenue, en tres columnas
                      contiguas.

                      Faltaba la de en medio. Las columnas de margen sumaban una
                      cosa, "Revenue net" decia otra, y los 338.457,24 de
                      diferencia --que afectan a 471 de 481 prestamos-- no
                      tenian columna: habia que creerse el salto. `otherConcepts`
                      se calculaba desde el principio y no se pintaba en ningun
                      sitio.

                      Y los nombres estaban al reves de lo util: el numero que
                      SI coincide con las Mini P&L Cards se llamaba "Revenue
                      net" aqui y "Total revenue" alli, mientras que los dos que
                      difieren --margen y total-- compartian la palabra "net".
                      Ahora el nombre repetido es el del numero repetido. */}
                  <Th className="text-right bg-[#A6DEFF]/20">
                    Margin
                    <span className="block font-normal normal-case text-[9px] text-slate-500">5 margin accounts</span>
                  </Th>
                  <Th className="text-right bg-[#A6DEFF]/20">Margin bps</Th>
                  <Th className="text-right">
                    Other revenue
                    <span className="block font-normal normal-case text-[9px] text-slate-500">fees, processing, origination</span>
                  </Th>
                  <Th className="text-right">
                    Total revenue
                    <span className="block font-normal normal-case text-[9px] text-slate-500">margin + other</span>
                  </Th>
                  {/* ⚠ LA COMISION Y LA CONTRIBUCION TAMBIEN EN LA TABLA, no
                      solo en las tarjetas. Con el total de las tarjetas restando
                      la comision y el de la tabla sin restarla, la misma pantalla
                      daria dos cifras con nombres parecidos en dos pestañas --
                      que es exactamente el fallo que la nota de arriba describe. */}
                  <Th className="text-right">
                    LO comm.
                  </Th>
                  <Th className="text-right bg-[#001A40]/5">
                    Contribution
                    <span className="block font-normal normal-case text-[9px] text-slate-500">after paying the LO</span>
                  </Th>
                  <Th className="text-right bg-[#001A40]/5">Contrib. bps</Th>
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
                    <Td className="max-w-[150px] truncate" title={l.loan_program ?? undefined}>{l.loan_program ?? "—"}</Td>
                    <Td className="text-center font-mono">{l.branch}</Td>
                    <Td className="text-right font-mono tabular-nums">{money(l.loan_amount)}</Td>
                    {marginCols.map((c) => (
                      <Amount key={c} v={l.concepts[c] ?? 0} amount={l.loan_amount}
                              flagged={l.unexpected_accounts.includes(c)} />
                    ))}
                    <Amount v={l.margin_net} amount={l.loan_amount} bold />
                    <Td className={`text-right font-mono tabular-nums font-bold ${num(l.margin_net)}`}>
                      {fmtBps(l.loan_amount ? (l.margin_net / l.loan_amount) * 10000 : null)}
                    </Td>
                    {/* Derivado de la resta, no de una segunda suma: asi no
                        puede discrepar del total que tiene al lado. */}
                    <Amount v={l.net - l.margin_net} amount={l.loan_amount}
                            title={otherRevenueDetail(l)} />
                    <Amount v={l.net} amount={l.loan_amount} bold />
                    {/* Null no es cero: el prestamo no cruza con Compensafe. */}
                    {l.commission == null
                      ? <Td className="text-right font-mono text-slate-300" title="This loan does not cross with Compensafe. Not the same as a zero commission.">—</Td>
                      : <Amount v={-l.commission} amount={l.loan_amount} />}
                    {l.contribution == null
                      ? <Td className="bg-[#001A40]/5 text-right font-mono text-slate-300" title="Without a known commission there is no contribution to compute. Showing the gross here would say nobody was paid.">—</Td>
                      : <Amount v={l.contribution} amount={l.loan_amount} bold />}
                    <Td className={`bg-[#001A40]/5 text-right font-mono tabular-nums font-bold ${num(l.contribution ?? 0)}`}>
                      {fmtBps(l.contribution_bps)}
                    </Td>
                  </tr>
                ))}
              </tbody>
              {/* Totals pinned to the bottom edge. With sixty loans in the list a
                  total that scrolls away is a total nobody reads. Same figures as
                  the summary card: one server-side aggregate feeds both. */}
              <tfoot className="sticky bottom-0 z-10">
                <tr className="border-t-2 border-[#001A40]/20 bg-[#001A40]/5 font-bold">
                  <Td className="text-[#001A40]">
                    {totals.loan_count} banked loan{totals.loan_count === 1 ? "" : "s"}
                  </Td>
                  <Td className="text-slate-500">
                    {totals.without_margin > 0 && (
                      <span className="text-rose-700">{totals.without_margin} with no margin</span>
                    )}
                  </Td>
                  <Td /><Td />
                  <Td className="text-right font-mono tabular-nums text-[#001A40]">
                    {money(totals.volume)}
                  </Td>
                  {marginCols.map((c) => (
                    <Amount key={c} v={totals.concepts[c] ?? 0} amount={totals.volume} bold />
                  ))}
                  <Amount v={totals.marginNet} amount={totals.volume} bold />
                  <Td className={`text-right font-mono font-bold tabular-nums ${num(totals.marginNet)}`}>
                    {fmtBps(totals.margin_bps)}
                  </Td>
                  {/* La misma resta que en cada fila, para que el pie cierre
                      igual que la linea de arriba. */}
                  <Amount v={totals.net - totals.marginNet} amount={totals.volume} bold
                          title={otherConcepts.length ? `Concepts outside margin: ${otherConcepts.join(", ")}` : undefined} />
                  <Amount v={totals.net} amount={totals.volume} bold />
                  <Amount v={-totals.commission} amount={totals.volume} bold />
                  <Amount v={totals.contribution} amount={totals.volume} bold />
                  <Td className={`bg-[#001A40]/5 text-right font-mono font-bold tabular-nums ${num(totals.contribution)}`}>
                    {fmtBps(totals.contribution_bps)}
                  </Td>
                </tr>
              </tfoot>
            </table>
          )}

          {/* Three different things, and only the first is a missing record.
              The old label called all of them "not in the master loan list",
              which was false for every case anyone reported: those loans were
              in the master, they had simply originated in another month. */}
          <StraySection
            bucket={data && !loading ? data.missing : null}
            title="Loan number not found in loan_officials"
            note="No record of these numbers anywhere in the master list."
          />
          <StraySection
            bucket={data && !loading ? data.other_period : null}
            title="Margin on loans from another month"
            note="These loans exist; they are not on this card because they originated in a different month. Revenue landing after origination, not a gap in the data."
          />
          <StraySection
            bucket={data && !loading ? data.out_of_scope : null}
            title="Margin on loans outside this card"
            note="Originated this month, but on another branch or through a channel this card does not cover."
          />
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

/** One loan whose margin is in these books but not on one of this card's loans. */
interface StrayLoan {
  loan_number: string;
  branch: string | null;
  concepts: Record<string, number>;
  total: number;
  origin: {
    branch: string | null; month: string | null; year: number | null;
    channel: string | null; program: string | null; officer: string | null;
  } | null;
  /** Exact opposite of the same concept in another branch, same month. */
  counterparts: { branch: string; concept: string; amount: number }[];
}

interface StrayBucket { rows: StrayLoan[]; total: number }

/**
 * Revenue in the books being read that does not belong to a loan on this card.
 *
 * Three sections rather than one, because the three causes are different and
 * two of them are not errors. A loan that originated in April and earns in June
 * is not missing from anything — saying so sent someone to check five loan
 * numbers one by one against a master list they were already in.
 */
function StraySection({ bucket, title, note }: { bucket: StrayBucket | null; title: string; note: string }) {
  if (!bucket || bucket.rows.length === 0) return null;
  return (
    <details className="m-5 rounded-xl border border-slate-200 bg-slate-50">
      <summary className="cursor-pointer px-4 py-2.5 text-xs font-semibold text-slate-700">
        {title} — {bucket.rows.length} loan{bucket.rows.length > 1 ? "s" : ""} · {money(bucket.total)}
      </summary>
      <p className="px-4 pb-2 text-[11px] text-slate-500">{note}</p>
      <table className="w-full border-collapse text-xs">
        <tbody>
          {bucket.rows.map((o) => (
            <tr key={`${o.loan_number}|${o.branch ?? ""}`} className="border-t border-slate-200/60 align-top">
              <Td className="font-mono">
                {o.loan_number}
                {o.origin ? (
                  <span className="ml-2 font-sans text-[10px] text-slate-500">
                    loan on branch {o.origin.branch ?? "—"}
                    {o.origin.month ? ` · ${o.origin.month} ${o.origin.year ?? ""}` : ""}
                    {o.origin.channel ? ` · ${o.origin.channel}` : ""}
                    {o.origin.program ? ` · ${o.origin.program}` : ""}
                    {o.origin.officer ? ` · ${o.origin.officer}` : ""}
                  </span>
                ) : (
                  // Not two dashes. loan_program and loan_officer live only in
                  // loan_officials and pl_transactions carries neither, so for a
                  // number with no master row there is nothing to show and no
                  // way there could be. Saying that beats an empty column.
                  <span className="ml-2 font-sans text-[10px] italic text-slate-400">
                    no master row, so no program or officer exists for this number
                  </span>
                )}
                {/* An equal and opposite entry in another branch is a transfer,
                    not revenue arriving from nowhere — and read through a
                    branch filter only one half of it is ever on screen. */}
                {o.counterparts.length > 0 && (
                  <span className="ml-2 inline-block rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 font-sans text-[10px] text-amber-800">
                    transfer · offset in branch {[...new Set(o.counterparts.map((c) => c.branch))].join(", ")}
                  </span>
                )}
              </Td>
              <Td className="text-center font-mono">{o.branch ?? "—"}</Td>
              <Td className="text-right font-mono tabular-nums">{fmt(o.total)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

// ─── Mini P&L card ────────────────────────────────────────────────────────────

/**
 * La tarjeta de un prestamo. La pinta `LoanPnlCard`, el MISMO componente que el
 * modulo de P&L por Loan Officer, para que las dos pantallas no se separen.
 *
 * ⚠ AQUI NO SE PASA `commission`, y esa es la unica diferencia de fondo entre
 * las dos: esta pantalla contesta "¿que dejo el prestamo?" y el modulo de LO
 * contesta "¿que dejo DESPUES de pagar al loan officer?". Por eso el banner
 * dice TOTAL REVENUE y no TOTAL CONTRIBUTION, y por eso el numero es otro.
 * Unificarlo es una decision de negocio sobre el P&L de sucursal, no un detalle
 * de presentacion.
 */
function MiniPL({ l }: { l: LoanRow }) {
  return (
    <LoanPnlCard
      title={l.loan_number}
      tag={l.branch}
      subtitle={l.borrower_name}
      meta={[l.loan_program, l.loan_info_channel, l.loan_officer].filter(Boolean).join(" · ") || null}
      amount={l.loan_amount}
      branch={l.branch}
      b2b={l.b2b}
      processing={l.processing}
      support_on_demand={l.support_on_demand}
      signals={<Signals l={l} />}
      lineas={l.lines}
      commission={l.commission}
      total={{ label: "TOTAL CONTRIBUTION", value: l.contribution }}
    />
  );
}

function Block({ title, total, amount, lines, loan }: {
  title: string; total: number; amount: number;
  /** Already ordered by the server, so every card lists the same concept at
   *  the same height and two cards can be read across. */
  lines: LoanLine[];
  /** Absent on the summary card, which spans every loan and so has no single
   *  branch to compare a booking against. */
  loan?: LoanRow;
}) {
  const badge = "bg-emerald-50 text-emerald-900 border-emerald-200/60";
  return (
    <>
      <div className={`my-1.5 flex items-center justify-between rounded-lg border px-3 py-1.5 text-xs font-bold ${badge}`}>
        <span className="uppercase tracking-wide">{title}</span>
        <span className={`font-mono tabular-nums ${total < 0 ? "text-rose-700" : ""}`}>
          {fmt(total)}
          <span className="ml-1 font-normal opacity-70">{fmtBps(bpsOf(total, amount))} bps</span>
        </span>
      </div>
      {lines.length === 0 && (
        <p className="px-3 pb-1 text-[10px] italic text-slate-400">None</p>
      )}
      {/*
        * ⚠ LA KEY ES EL INDICE Y NO EL gl_code, y es la consecuencia visible de
        * que las lineas vengan crudas: un prestamo puede traer TRES filas de
        * 41205 --el cobro, su salida de una sucursal y su entrada en otra-- y
        * con el gl_code por key React pintaria una sola.
        */}
      {lines.map(({ gl_code, gl_name, category_7, branch, amount: v }, i) => {
        /*
         * ⚠ LA SUCURSAL SALE DE LA LINEA, NO DE `concept_branches`. Ese mapa es
         * por category_7, asi que decia "@700" en TODAS las filas de "Fee
         * Income, Net" en cuanto una sola estuviera en la 700 -- y con las
         * lineas crudas eso es justo lo que hay que distinguir: cual de las tres
         * filas de 41205 es la de corporativo.
         */
        const elsewhere = loan && branch && branch !== loan.branch ? branch : null;
        const flagged = loan ? loan.unexpected_accounts.includes(category_7) : false;
        return (
          <div key={`${gl_code}-${i}`} className="flex items-baseline justify-between gap-2 px-3 py-0.5 text-[11px]">
            <span className={`truncate ${flagged ? "text-amber-700" : "text-slate-600"}`}>
              {/* The GL code, so a line can be tied back to the ledger.
                  category_7 nets several accounts into one figure that
                  reconciles against nothing. */}
              <span className="mr-1.5 font-mono text-[9px] text-slate-400">{gl_code}</span>
              {/* El mismo nombre que en la tarjeta, por el mismo helper:
                  "Back-end Margin" antes que "BM Margin", pero "Lender Credits"
                  antes que su category_7, que lo fundiria con otras dos. */}
              {conceptLabel(gl_name, category_7)}
              {elsewhere && (
                <span title={`Booked in branch ${elsewhere}, while the loan is branch ${loan?.branch}. Common and not an error: part of the margin is booked in 700 by design.`}
                  className="ml-1 rounded bg-slate-200/70 px-1 py-0.5 font-mono text-[9px] text-slate-600">
                  @{elsewhere}
                </span>
              )}
              {flagged && (
                <span title="This branch does not normally carry this account." className="ml-1 text-amber-600">!</span>
              )}
            </span>
            <span
              title={signHint(v)}
              className={`shrink-0 font-mono tabular-nums text-xs ${itemCls(v)}`}
            >
              {fmt(v)}
              <span className="ml-1 font-mono text-[11px] font-normal text-slate-500">{fmtBps(bpsOf(v, amount))} bps</span>
            </span>
          </div>
        );
      })}
    </>
  );
}

// ─── Shared bits ──────────────────────────────────────────────────────────────

/**
 * The month as one card, first in the carousel.
 *
 * Same concepts and same structure as the individual cards, so the two can be
 * read against each other without translating. Its net is the sum of theirs.
 */
function SummaryCard({ s, month }: { s: Summary; month: string }) {

  return (
    <div className="flex w-[340px] shrink-0 flex-col justify-between overflow-hidden rounded-2xl border-2 border-[#001A40]/20 bg-white shadow-xs">
      <div>
        <div className="flex flex-col gap-1 border-b border-slate-200 bg-[#001A40]/5 p-3.5 text-xs font-bold text-[#001A40]">
          <span className="uppercase tracking-wider">{month} · banked loans</span>
          <span className="font-mono tabular-nums text-sm">
            {s.loan_count} banked loan{s.loan_count === 1 ? "" : "s"} · {money(s.volume)}
          </span>
          {/* Stated up front, not footnoted. Loans that earned nothing still sit
              in the denominator — hiding them would lift the month's bps by
              shrinking the volume it is measured against. */}
          {s.without_margin > 0 && (
            <span className="font-semibold text-rose-700">
              {s.without_margin} with no margin received
            </span>
          )}
        </div>
        <div className="px-3 pt-2">
          <Block title="Revenue and direct costs" total={s.revenue} amount={s.volume} lines={s.lines} />
          {/* La comision del mes, con su origen dicho: en esta pantalla nadie
              espera una cifra que no este en la contabilidad. */}
          <div className="my-1.5 flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-bold text-slate-700">
            {/* El mismo nombre que en las tarjetas de prestamo, y sin repetir
                el origen: eso se dice una vez, en la definicion del total. */}
            <span className="uppercase tracking-wide">&minus; Commission on loans</span>
            <span className="font-mono tabular-nums text-rose-700">{fmt(-s.commission)}</span>
          </div>
          {s.loans_without_commission > 0 && (
            <p className="px-3 pb-1 text-[10px] text-slate-500">
              {s.loans_without_commission} loan{s.loans_without_commission === 1 ? " does" : "s do"} not cross
              with Compensafe, so no commission is known for {s.loans_without_commission === 1 ? "it" : "them"} —
              left out rather than counted as zero.
            </p>
          )}
        </div>
      </div>
      <NetBanner net={s.contribution} netBps={s.contribution_bps} />
    </div>
  );
}

/**
 * Net result, coloured by what it says. Profit keeps the navy banner with the
 * figure in light emerald; a loss switches the whole banner to rose, because a
 * negative result is the one thing in this window that should be impossible to
 * scroll past.
 */
function NetBanner({ net, netBps }: { net: number; netBps: number | null }) {
  const loss = net < 0;
  return (
    <div
      className={`mt-2 flex items-center justify-between rounded-b-2xl p-3 text-xs font-bold shadow-xs ${
        loss ? "border-t border-rose-200 bg-rose-100 text-rose-900" : "bg-[#001A40] text-white"
      }`}
    >
      {/* EL MISMO NOMBRE QUE EN TABLE LIST, porque es el MISMO numero.
          Se llamo "NET MARGIN" --falso, esto es todo el revenue-- y luego
          "REVENUE NET", que era correcto pero distinto del nombre que la tabla
          le daba a esta misma cifra. Que el numero que coincide entre las dos
          vistas se llamara de dos formas, mientras los dos que NO coinciden
          compartian la palabra "net", es lo que hacia parecer que no cuadraban. */}
      <span>TOTAL CONTRIBUTION</span>
      <span>
        <span className={`font-mono font-bold tabular-nums ${loss ? "text-rose-700" : "text-emerald-300"}`}>
          {fmt(net)}
        </span>
        <span className={`ml-1.5 font-mono text-[11px] ${loss ? "text-rose-800" : "text-emerald-400"}`}>
          {fmtBps(netBps)} bps
        </span>
      </span>
    </div>
  );
}

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
      {/*
       * ⚠ B2B / ON DEMAND / PROCESSING SALEN DE LA TARJETA, NO DE AQUI, y por
       * eso se quitaron: la tarjeta compartida ya los pinta desde sus propias
       * props, y este componente se le pasa ademas como `signals`, asi que los
       * tres salian DOS VECES en la misma ficha.
       *
       * Aqui se quedan solo los avisos que la tarjeta no conoce.
       */}
      {l.pl_pending && (
        <span title="No P&L is loaded for this month yet, so the commission is subtracted from revenue that has not been booked. Not a loss: a missing period."
              className="ml-1 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[9px] font-bold text-amber-700">
          P&L pending
        </span>
      )}
      {l.no_margin && (
        <span className="ml-1 rounded-full border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-[9px] font-bold text-rose-700">
          no margin
        </span>
      )}
      {l.foreign_months.length > 0 && (
        <span title={`Margin posted in ${l.foreign_months.join(", ")}`}
              className="ml-1 rounded-full border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[9px] font-semibold text-sky-800">
          margin in {l.foreign_months.join(", ")}
        </span>
      )}
    </span>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <th className={`whitespace-nowrap px-2 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-700 ${className}`}>{children}</th>;
}

function Td({ children = null, className = "", title }: { children?: React.ReactNode; className?: string; title?: string }) {
  // `title` so a truncated cell can still be read in full on hover — the same
  // rule the hierarchy column of the P&L uses.
  return <td title={title} className={`whitespace-nowrap px-2 py-1.5 text-slate-700 ${className}`}>{children}</td>;
}

function Signal({ label }: { label: string }) {
  // Spelled out. A single letter needs a legend, and a legend is one more
  // thing to read before the number underneath makes sense.
  return (
    <span className="rounded-full bg-[#A6DEFF]/40 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-[#001A40]">
      {label}
    </span>
  );
}

function Amount({ v, amount, flagged = false, bold = false, title }: {
  v: number; amount: number; flagged?: boolean; bold?: boolean;
  /** Desglose de la celda. El aviso de `flagged` manda si los dos existen. */
  title?: string;
}) {
  return (
    <td className={`whitespace-nowrap px-2 py-1.5 text-right ${flagged ? "bg-amber-50" : ""}`}
        title={flagged ? "This branch does not normally carry this account." : title}>
      <span className={`font-mono tabular-nums text-xs ${bold ? "font-bold" : ""} ${num(v)}`}>{fmt(v)}</span>
      {v !== 0 && (
        <span className="ml-1 font-mono text-[10px] font-normal text-slate-400">{fmtBps(bpsOf(v, amount))}</span>
      )}
    </td>
  );
}
