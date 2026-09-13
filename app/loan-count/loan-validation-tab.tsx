"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { ChevronDown, ChevronRight, Download, AlertTriangle, CheckCircle, SlidersHorizontal, X } from "lucide-react";
import { ReportFilter } from "@/components/report-filter";
import * as XLSX from "xlsx";
import { useActiveBranches } from "@/components/branch-filter-provider";
import type { ValidationResult, ValidationRow, SurplusRow } from "@/app/api/loan-validation/route";
import {
  activeChips,
  buildFacetOptions,
  clearOne,
  initialFilters,
  NO_VALUE,
  rowMatches,
  type LoanValidationFilters,
  type RangeFilter,
} from "@/lib/loan-validation-filters";

// ─── Formatting ───────────────────────────────────────────────────────────────

function fmtUSD(n: number | null | undefined) {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}
function fmtBPS(n: number | null | undefined) {
  if (n == null) return "—";
  return `${n.toFixed(1)} bps`;
}
function fmtMov(n: number) {
  const cls = n >= 0 ? "text-emerald-700" : "text-red-600";
  const s = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(Math.abs(n));
  return <span className={`font-mono ${cls}`}>{n < 0 ? `(${s})` : s}</span>;
}

// ─── xlsx export helper ───────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function exportToXlsx(filename: string, rows: Record<string, any>[], cols: { key: string; label: string }[]) {
  const aoa = [
    cols.map((c) => c.label),
    ...rows.map((r) => cols.map((c) => r[c.key] ?? "")),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Data");
  XLSX.writeFile(wb, filename);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// ─── Surplus section ──────────────────────────────────────────────────────────

/**
 * Apuntes de margen cuyo numero de prestamo no esta en la lista maestra.
 *
 * Tenia DOS modos y uno se fue con la pestaña B2B: aquel partia las filas en
 * tres cubos --el prestamo existe pero no esta marcado, no esta en officials, y
 * el numero no se pudo resolver-- porque solo con el flag b2b tenia sentido
 * distinguirlos. Aqui no hay flag que comprobar: o el prestamo esta en la lista
 * o no esta.
 */
function SurplusSection({ rows }: { rows: SurplusRow[] }) {
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;

  function handleExport() {
    exportToXlsx(`surplus-all-loans-${todayISO()}.xlsx`, rows.map((r) => ({
      loan_number:       r.loan_number ?? "",
      check_description: r.check_description ?? "",
      gl_code:           r.gl_code ?? "",
      branch:            r.branch ?? "",
      month:             r.month ?? "",
      year:              r.year ?? "",
      movement:          r.movement,
    })), [
      { key: "loan_number",       label: "Loan Number" },
      { key: "check_description", label: "Check Description" },
      { key: "gl_code",           label: "GL Code" },
      { key: "branch",            label: "Branch" },
      { key: "month",             label: "Month" },
      { key: "year",              label: "Year" },
      { key: "movement",          label: "Movement" },
    ]);
  }

  return (
    <div className="rounded-xl border border-blue-100 bg-blue-50/40 overflow-hidden">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((o) => !o); } }}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-blue-50/80 transition-colors cursor-pointer"
      >
        {open ? <ChevronDown size={13} className="text-blue-500" /> : <ChevronRight size={13} className="text-blue-500" />}
        <span className="text-xs font-semibold text-blue-700">{rows.length} surplus in accounting</span>
        <span className="text-xs text-blue-500">
          — margin transactions whose loan number is not in the Loan Officials list
        </span>
        {open && (
          <button
            onClick={(e) => { e.stopPropagation(); handleExport(); }}
            className="ml-auto flex items-center gap-1 rounded-lg border border-blue-200 bg-white px-2 py-1 text-[11px] text-blue-600 hover:bg-blue-50"
          >
            <Download size={11} /> Excel
          </button>
        )}
      </div>

      {open && (
        <div className="border-t border-blue-100">
          <div className="overflow-auto max-h-72">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-blue-50">
                <tr className="text-left text-blue-600/70 border-b border-blue-100">
                  <th className="px-3 py-2 font-medium">Loan Number</th>
                  <th className="px-3 py-2 font-medium">Description</th>
                  <th className="px-3 py-2 font-medium text-right">Movement</th>
                  <th className="px-3 py-2 font-medium">Month</th>
                  <th className="px-3 py-2 font-medium">Year</th>
                  <th className="px-3 py-2 font-medium">Branch</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-b border-blue-50 hover:bg-blue-50/60">
                    <td className="px-3 py-1.5 font-mono text-gray-700">
                      {r.loan_number ?? <span className="text-gray-400 italic">no loan#</span>}
                      {r.incomplete && (
                        <span className="ml-1 rounded bg-orange-100 px-1 py-0.5 text-[10px] font-medium text-orange-600">ambiguous</span>
                      )}
                    </td>
                    <td className="max-w-[200px] truncate px-3 py-1.5 text-gray-600" title={r.check_description ?? ""}>{r.check_description ?? "—"}</td>
                    <td className="px-3 py-1.5 text-right">{fmtMov(r.movement)}</td>
                    <td className="px-3 py-1.5 text-gray-600">{r.month ?? "—"}</td>
                    <td className="px-3 py-1.5 text-gray-600">{r.year ?? "—"}</td>
                    <td className="px-3 py-1.5 text-gray-600">{r.branch ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}


/**
 * El canal de entrada del prestamo, distinguible de un vistazo.
 *
 * Banked y brokered no son dos tonos de lo mismo: ganan por mecanismos
 * distintos y por cuentas distintas. Vivia en la tabla de B2B, que ya no
 * existe; se queda porque la usa el detalle de All Loans, donde conviven los
 * dos canales desde que dejaron de filtrarse.
 */
function ChannelChip({ c }: { c: string | null }) {
  if (!c?.trim()) return <span className="text-gray-300">—</span>;
  const brokered = c.trim() === "Brokered";
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold ${
      brokered ? "bg-violet-100 text-violet-700" : "bg-sky-100 text-sky-800"}`}>
      {c}
    </span>
  );
}

// ─── All Loans: types & helpers ───────────────────────────────────────────────

const MONTH_ORDER = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

function sortMonthKey(a: string, b: string): number {
  const parse = (s: string) => {
    const parts = s.split(" ");
    const yr = parseInt(parts[parts.length - 1], 10) || 0;
    const ms = parts.slice(0, -1).join(" ");
    const mi = MONTH_ORDER.findIndex((m) => m.toLowerCase().startsWith(ms.slice(0, 3).toLowerCase()));
    return yr * 100 + (mi >= 0 ? mi : 99);
  };
  return parse(a) - parse(b);
}

function monthKey(r: ValidationRow): string {
  return r.month && r.year ? `${r.month} ${r.year}` : r.month ?? "";
}


// ─── All Loans: Detail view ───────────────────────────────────────────────────

function DetailView({ rows }: { rows: ValidationRow[] }) {
  /**
   * ¿Viene lead_source del archivo o ya del espejo?
   *
   * Se lee de las propias filas, asi que el aviso se apaga solo el dia que el
   * endpoint cambie de origen. Una bandera en la pantalla habria que acordarse
   * de quitarla, y nadie se acuerda.
   */
  const fromFile = rows.some((r) => r.lead_source_origin === "loan_officials_file");

  // Ya vienen filtradas: el panel de arriba es el unico sitio donde se filtra.
  // Antes esta vista tenia DOS cajas propias en las cabeceras, asi que habia
  // dos mecanismos y los chips no sabian de aquellos.
  const visible = rows;

  if (visible.length === 0) return (
    <div className="rounded-xl border border-gray-100 bg-white px-6 py-10 text-center text-sm text-gray-400">
      No loans found for this filter combination.
    </div>
  );

  return (
    <div className="overflow-auto rounded-xl border border-gray-200 bg-white shadow-sm max-h-[480px]">
      <table className="w-full text-xs">
        <thead className="sticky top-0 z-10 bg-gray-50">
          <tr className="border-b border-gray-100 text-gray-500 align-top">
            {/* Identificacion primero, dinero despues, estado al final. El
                Status abria la tabla y era lo ultimo que se necesitaba para
                localizar una fila: primero se busca el prestamo, luego se mira
                que le paso. */}
            <th className="px-3 py-2 font-medium text-left whitespace-nowrap">Year</th>
            <th className="px-3 py-2 font-medium text-left whitespace-nowrap">Month</th>
            <th className="px-3 py-2 font-medium text-left whitespace-nowrap">Loan Number</th>
            <th className="px-3 py-2 font-medium text-left whitespace-nowrap">Borrower</th>
            <th className="px-3 py-2 font-medium text-left whitespace-nowrap">Loan Officer</th>
            <th className="px-3 py-2 font-medium text-left">Branch</th>
            <th className="px-3 py-2 font-medium text-left whitespace-nowrap">Loan Program</th>
            {/* El aviso sale del origen que trae la propia fila, no de una
                bandera: el dia que esta columna venga de Encompass, el asterisco
                desaparece solo. */}
            <th className="px-3 py-2 font-medium text-left whitespace-nowrap"
                title={fromFile
                  ? "From the uploaded loan file, not from Encompass. 103 of 436 loans carry values Encompass does not use (Encompass Integration, B2B Strategy, Referral, External Referral, blank) — capture leftovers that will change when this column moves to the mirror."
                  : undefined}>
              Lead Source{fromFile && <span className="ml-0.5 text-amber-600">*</span>}
            </th>
            <th className="px-3 py-2 font-medium text-left whitespace-nowrap">Channel</th>
            <th className="px-3 py-2 font-medium text-right whitespace-nowrap">Loan Amount</th>
            {/* TWO GROUPS, TWO COLUMNS, BOTH ALWAYS VISIBLE.
                No Division/Branch/Both switch on purpose: the job is to check
                in one pass that every branch was paid for its loans, and a
                switch would hide exactly the comparison you came to make.
                The per-account breakdown is not lost -- it lives in the title. */}
            <th className="px-3 py-2 font-medium text-right whitespace-nowrap bg-sky-50/70">
              Division margin
              <span className="block text-[10px] font-normal text-gray-400">DM + RM</span>
            </th>
            <th className="px-3 py-2 font-medium text-right whitespace-nowrap bg-sky-50/70">BPS</th>
            <th className="px-3 py-2 font-medium text-right whitespace-nowrap bg-emerald-50/70">
              Branch margin
              <span className="block text-[10px] font-normal text-gray-400">BM + Discount + LO + Brokered</span>
            </th>
            <th className="px-3 py-2 font-medium text-right whitespace-nowrap bg-emerald-50/70">BPS</th>
            {/* Lo que cobra una PERSONA, no una cuenta contable. Separada de las
                dos de margen y en su propio tono por eso. */}
            <th className="px-3 py-2 font-medium text-right whitespace-nowrap bg-violet-50/70">
              LO commission
              <span className="block text-[10px] font-normal text-gray-400">Compensafe</span>
            </th>
            <th className="px-3 py-2 font-medium text-right whitespace-nowrap bg-violet-50/70">BPS</th>
            <th className="px-3 py-2 font-medium text-left whitespace-nowrap">Status</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((row) => {
            const missing = row.status === "missing";
            return (
              <tr
                key={`${row.loan_number}-${row.month}-${row.year}`}
                className={`border-b border-gray-50 hover:brightness-95 ${missing ? "bg-amber-50/70" : ""}`}
              >
                <td className="px-3 py-1.5 text-gray-600 whitespace-nowrap">{row.year ?? "—"}</td>
                <td className="px-3 py-1.5 text-gray-600 whitespace-nowrap">{row.month ?? "—"}</td>
                <td className="px-3 py-1.5 font-mono text-gray-800 whitespace-nowrap">{row.loan_number}</td>
                <td className="max-w-[140px] truncate px-3 py-1.5 text-gray-700" title={row.borrower_name ?? ""}>{row.borrower_name ?? "—"}</td>
                <td className="max-w-[140px] truncate px-3 py-1.5 text-gray-700" title={row.loan_officer ?? ""}>{row.loan_officer ?? "—"}</td>
                <td className="px-3 py-1.5 text-gray-600 whitespace-nowrap">{row.branch ?? "—"}</td>
                <td className="max-w-[150px] truncate px-3 py-1.5 text-gray-600" title={row.loan_program ?? undefined}>{row.loan_program ?? "—"}</td>
                <td className="max-w-[150px] truncate px-3 py-1.5 text-gray-600" title={row.lead_source ?? undefined}>{row.lead_source ?? "—"}</td>
                <td className="px-3 py-1.5 whitespace-nowrap"><ChannelChip c={row.loan_info_channel} /></td>
                <td className="px-3 py-1.5 text-right font-mono text-gray-700 whitespace-nowrap">{fmtUSD(row.loan_amount)}</td>
                {/* Each group prints only where it has a booking. "No margin"
                    in amber rather than a dash: in a margin column a dash reads
                    as missing data, and this is an accounting fact. It is the
                    whole reason the two columns are separate -- 48 loans have
                    the left one and not the right, and 46 the other way. */}
                <td className={`px-3 py-1.5 text-right whitespace-nowrap bg-sky-50/40 ${row.division_received ? "" : "text-amber-700"}`}
                    title={row.division_received
                      ? `DM Margin ${row.dm_total ?? "—"} · RM Margin ${row.rm_total ?? "—"}`
                      : "No booking in DM Margin or RM Margin: the division was not paid for this loan."}>
                  {row.division_total == null ? "No margin" : fmtMov(row.division_total)}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-gray-600 whitespace-nowrap bg-sky-50/40">
                  {fmtBPS(row.bps)}
                </td>
                <td className={`px-3 py-1.5 text-right whitespace-nowrap bg-emerald-50/40 ${row.branch_received ? "" : "text-amber-700"}`}
                    title={row.branch_received
                      ? `BM Margin ${row.bm_total ?? "—"} · Discount Income ${row.discount_total ?? "—"} · LO Margin ${row.lo_margin_total ?? "—"} · Brokered Origination ${row.brokered_total ?? "—"}`
                      : "No booking in any branch margin account: the branch was not paid for this loan."}>
                  {row.branch_margin_total == null ? "No margin" : fmtMov(row.branch_margin_total)}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-gray-600 whitespace-nowrap bg-emerald-50/40">
                  {fmtBPS(row.branch_bps)}
                </td>
                {/* Null is not zero: no row in Compensafe means nobody knows
                    what was paid, and 0.00 would claim it was nothing. */}
                <td className="px-3 py-1.5 text-right whitespace-nowrap bg-violet-50/40">
                  {row.lo_commission == null
                    ? <span className="text-gray-300" title="No commission data for this loan">—</span>
                    : fmtMov(row.lo_commission)}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-gray-600 whitespace-nowrap bg-violet-50/40">
                  {fmtBPS(row.lo_commission_bps)}
                </td>
                <td className="px-3 py-1.5">
                  {missing ? (
                    <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                      <AlertTriangle size={9} /> Missing
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-semibold text-green-700">
                      <CheckCircle size={9} /> Match
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── All Loans: metric card ───────────────────────────────────────────────────

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 shadow-sm">
      <div className="text-[10px] font-medium uppercase tracking-wide text-gray-400">{label}</div>
      <div className="mt-1 text-base font-semibold text-gray-800">{value}</div>
    </div>
  );
}

// ─── All Loans: filter controls ───────────────────────────────────────────────

type SetFilters = React.Dispatch<React.SetStateAction<LoanValidationFilters>>;

/** Un desplegable de faceta. Las opciones y los conteos llegan ya calculados. */
function Facet({ label, k, f, set, o, c, search }: {
  label: string;
  k: keyof LoanValidationFilters;
  f: LoanValidationFilters;
  set: SetFilters;
  o: Record<string, string[]>;
  c: Record<string, Record<string, number>>;
  search?: boolean;
}) {
  return (
    <div>
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-gray-400">{label}</span>
      <ReportFilter
        label={label}
        options={o[k as string] ?? []}
        counts={c[k as string]}
        searchable={search}
        selected={f[k] as string[]}
        onChange={(v) => set((p) => ({ ...p, [k]: v }))}
      />
    </div>
  );
}

/** Caja de texto: para identificadores, donde un desplegable no ayuda. */
function TextFacet({ label, k, f, set }: {
  label: string; k: "loanNumber" | "borrower"; f: LoanValidationFilters; set: SetFilters;
}) {
  return (
    <div>
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-gray-400">{label}</span>
      <input
        value={f[k]}
        onChange={(e) => set((p) => ({ ...p, [k]: e.target.value }))}
        placeholder="Contains…"
        className="h-7 w-full rounded-lg border border-gray-200 bg-white px-2.5 text-xs placeholder-gray-300 focus:outline-none focus:ring-1 focus:ring-blue-300"
      />
    </div>
  );
}

/**
 * Rango numerico, con "sin valor" como CASILLA APARTE y no como un valor del
 * rango.
 *
 * Un prestamo sin apunte y uno con un apunte de 0,00 son hallazgos distintos, y
 * un rango min=0 max=0 los mezclaria. Marcar la casilla desactiva el rango
 * porque preguntan cosas incompatibles: no se puede pedir "sin importe" y "entre
 * dos importes" a la vez.
 */
function RangeFacet({ label, k, f, set }: {
  label: string;
  k: "loanAmount" | "divisionMargin" | "branchMargin" | "loCommission";
  f: LoanValidationFilters;
  set: SetFilters;
}) {
  const r = f[k];
  const upd = (patch: Partial<RangeFilter>) => set((p) => ({ ...p, [k]: { ...p[k], ...patch } }));
  return (
    <div>
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-gray-400">{label}</span>
      <div className="flex items-center gap-1">
        <input
          type="number" value={r.min} disabled={r.emptyOnly}
          onChange={(e) => upd({ min: e.target.value })}
          placeholder="min"
          className="h-7 w-full min-w-0 rounded-lg border border-gray-200 bg-white px-2 text-xs placeholder-gray-300 disabled:bg-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-300"
        />
        <span className="text-gray-300">–</span>
        <input
          type="number" value={r.max} disabled={r.emptyOnly}
          onChange={(e) => upd({ max: e.target.value })}
          placeholder="max"
          className="h-7 w-full min-w-0 rounded-lg border border-gray-200 bg-white px-2 text-xs placeholder-gray-300 disabled:bg-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-300"
        />
      </div>
      <label className="mt-1 flex cursor-pointer items-center gap-1.5 text-[11px] text-gray-600">
        <input
          type="checkbox" checked={r.emptyOnly}
          onChange={(e) => upd({ emptyOnly: e.target.checked, min: "", max: "" })}
          className="h-3 w-3 rounded border-gray-300 accent-blue-600"
        />
        No value
      </label>
    </div>
  );
}

// ─── All Loans section ────────────────────────────────────────────────────────

/**
 * All Loans carga TODOS los periodos y sucursales, y filtra en el cliente.
 *
 * Por eso ya no recibe months/years/branches: pasarselos al endpoint es lo que
 * recortaba el conjunto del que salen las opciones de los desplegables, y lo
 * que dejaba 123 prestamos de 2025 inalcanzables.
 */
function AllLoansSection() {
  const [data, setData] = useState<ValidationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  /**
   * Los catorce filtros en UN objeto, y el panel plegado por defecto.
   *
   * Antes eran tres sueltos en la barra -- Loan officer, Status y la caja de
   * numero -- y ya con tres no se veia cuales estaban puestos. Con catorce eso
   * deja de ser incomodo y pasa a ser una fuente de error: alguien lee un total
   * creyendo que es el total cuando lleva media tabla filtrada.
   *
   * Por eso los controles se pliegan y los ACTIVOS se quedan siempre fuera,
   * como chips. Se eligio esto frente al embudo por cabecera, que es mas
   * elegante y esconde justo el estado que importa.
   */
  const [filters, setFilters] = useState<LoanValidationFilters>(() => initialFilters());
  const [filtersOpen, setFiltersOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      /*
       * ⚠ SIN month, year NI branch: se cargan TODOS los periodos y todas las
       * sucursales, y filtra el panel.
       *
       * Se pasaban, y de ahi salio un fallo que cuesta ver: las opciones de
       * cada desplegable se derivan de las filas cargadas, asi que con el año
       * en curso preseleccionado el endpoint devolvia solo 2026 -- y entonces
       * el desplegable de AÑO solo se ofrecia a si mismo. Habia 123 prestamos
       * de 2025 invisibles y sin forma de llegar a ellos, porque para verlos
       * habia que elegir un año que la lista ya no contenia.
       *
       * Es la regla que ya habiamos acordado --opciones del conjunto completo y
       * no de lo filtrado-- rota por debajo: se cumplia dentro de lo cargado, y
       * lo cargado ya venia recortado.
       *
       * Cargar todo cuesta poco: 436 prestamos y unas 1.500 filas de margen.
       * Y deja un solo sitio donde se filtra, que es lo que hace que no pueda
       * volver a pasar.
       */
      // Sin `type`: el endpoint ya no tiene modos. Pasarlo era decirle que
      // eligiera entre una sola cosa.
      const res = await fetch("/api/loan-validation");
      const json = await res.json();
      if (!res.ok) { setError(json.error ?? "Failed to load"); return; }
      setData(json);
    } finally {
      setLoading(false);
    }
    // Sin dependencias: la peticion no lleva filtros, asi que se hace UNA vez.
    // Antes se repetia con cada cambio de mes, año o sucursal.
  }, []);

  useEffect(() => { load(); }, [load]);

  const loOptions = useMemo(
    () => [...new Set((data?.rows ?? []).map((r) => r.loan_officer).filter((x): x is string => x != null))].sort(),
    [data],
  );

  /**
   * Opciones y conteos del CONJUNTO COMPLETO, no de lo filtrado.
   *
   * Depende de `data` y de nada mas, asi que elegir una sucursal no vacia el
   * desplegable de programas: sin esto, filtrar por una cosa encierra al
   * usuario y le obliga a limpiar todo para volver. Misma decision que en
   * Metrics B2B.
   */
  const { options: facetOptions, counts: facetCounts } = useMemo(
    () => buildFacetOptions(data?.rows ?? []),
    [data],
  );

  const filteredRows = useMemo(() => {
    if (!data) return [];
    // Un solo camino: el panel. La caja de numero de la barra de arriba se fue
    // con ella, y era el mismo filtro por una segunda via.
    return data.rows.filter((r) => rowMatches(r, filters));
  }, [data, filters]);

  const chips = useMemo(() => activeChips(filters), [filters]);

  /**
   * Un año elegido del que no hay ni una fila cargada.
   *
   * Se dice, no se corrige: caer en silencio a otro año enseñaria cifras
   * correctas de un periodo que nadie pidio. El 1 de enero el filtro vendra
   * marcado con el año nuevo y esto sera lo unico que explique una tabla vacia.
   */
  const yearsLoaded = useMemo(
    () => new Set((data?.rows ?? []).map((r) => String(r.year ?? ""))),
    [data],
  );
  const yearsWithoutData = filters.year.filter((y) => y !== NO_VALUE && !yearsLoaded.has(y));

  const matchedRows = filteredRows.filter((r) => r.status === "match");
  const loanCount = filteredRows.length;
  const amtRows = filteredRows.filter((r) => r.loan_amount != null);
  const avgLoanAmount = amtRows.length > 0 ? amtRows.reduce((s, r) => s + r.loan_amount!, 0) / amtRows.length : null;
  /**
   * Dos medias, no una. `bps` es el de DIVISION y `branch_bps` el de SUCURSAL,
   * y viven en escalas distintas -- mediana 65 contra 350 -- asi que una sola
   * tarjeta "Avg BPS" no podia decir cual estaba enseñando.
   */
  const bpsRows = matchedRows.filter((r) => r.bps != null);
  const avgBPS = bpsRows.length > 0 ? bpsRows.reduce((s, r) => s + r.bps!, 0) / bpsRows.length : null;
  const branchBpsRows = matchedRows.filter((r) => r.branch_bps != null);
  const avgBranchBPS = branchBpsRows.length > 0
    ? branchBpsRows.reduce((s, r) => s + r.branch_bps!, 0) / branchBpsRows.length
    : null;

  const showSurplus = !!data && data.surplus.length > 0 && filters.status.length === 0;

  function handleExport() {
    if (!data || filteredRows.length === 0) return;
    const today = todayISO();
    {
      // Sin un segundo filtrado: `filteredRows` ya es lo que se ve. El export
      // llevaba su propia copia de dos filtros y podia decir otra cosa que la
      // tabla de al lado.
      const exportRows = filteredRows
        .map((r) => ({
          // Mismo orden que la tabla: identificacion, dinero, estado.
          year:          r.year ?? "",
          month:         r.month ?? "",
          loan_number:   r.loan_number,
          borrower_name: r.borrower_name ?? "",
          loan_officer:  r.loan_officer ?? "",
          branch:        r.branch ?? "",
          loan_program:  r.loan_program ?? "",
          lead_source:   r.lead_source ?? "",
          channel:       r.loan_info_channel ?? "",
          loan_amount:   r.loan_amount ?? "",
          division_margin: r.division_total ?? "",
          division_bps:    r.bps ?? "",
          branch_margin:   r.branch_margin_total ?? "",
          branch_bps:      r.branch_bps ?? "",
          lo_commission:     r.lo_commission ?? "",
          lo_commission_bps: r.lo_commission_bps ?? "",
          dm_margin:       r.dm_total ?? "",
          rm_margin:       r.rm_total ?? "",
          bm_margin:       r.bm_total ?? "",
          discount_income: r.discount_total ?? "",
          lo_margin:       r.lo_margin_total ?? "",
          brokered_margin: r.brokered_total ?? "",
          status:        r.status === "missing" ? "Missing" : "Match",
        }));
      exportToXlsx(`loan-validation-all-loans-detail-${today}.xlsx`, exportRows, [
        { key: "year",          label: "Year" },
        { key: "month",         label: "Month" },
        { key: "loan_number",   label: "Loan Number" },
        { key: "borrower_name", label: "Borrower" },
        { key: "loan_officer",  label: "Loan Officer" },
        { key: "branch",        label: "Branch" },
        { key: "loan_program",  label: "Loan Program" },
        { key: "lead_source",   label: "Lead Source" },
        { key: "channel",       label: "Channel" },
        { key: "loan_amount",   label: "Loan Amount" },
        // Los tres grupos primero, que son lo que se viene a mirar; el desglose
        // por cuenta despues, para quien quiera reconstruir las sumas.
        { key: "division_margin",   label: "Division margin (DM+RM)" },
        { key: "division_bps",      label: "Division BPS" },
        { key: "branch_margin",     label: "Branch margin (BM+Discount+LO+Brokered)" },
        { key: "branch_bps",        label: "Branch BPS" },
        { key: "lo_commission",     label: "LO commission (Compensafe)" },
        { key: "lo_commission_bps", label: "LO commission BPS" },
        { key: "dm_margin",         label: "DM Margin (41309)" },
        { key: "rm_margin",         label: "RM Margin (41307)" },
        { key: "bm_margin",         label: "BM Margin (41306)" },
        { key: "discount_income",   label: "Discount Income (41200)" },
        { key: "lo_margin",         label: "LO Margin (41305)" },
        { key: "brokered_margin",   label: "Brokered Origination (41870)" },
        { key: "status",            label: "Status" },
      ]);
    }
  }

  return (
    <div className="space-y-4">
      {/* ── Filters: collapsed controls, permanent chips ──────────────────── */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setFiltersOpen((o) => !o)}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
              chips.length > 0
                ? "border-sky-200 bg-sky-50 text-sky-900"
                : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
            }`}
          >
            <SlidersHorizontal size={13} />
            Filters{chips.length > 0 ? ` (${chips.length})` : ""}
            <ChevronDown size={13} className={`transition-transform ${filtersOpen ? "rotate-180" : ""}`} />
          </button>

          {/* Los filtros ACTIVOS viven fuera del panel, siempre visibles.
              Plegar los controles esta bien; plegar el estado no. Un total
              leido sin saber que hay tres filtros puestos es el error que esto
              existe para evitar. */}
          {chips.map((c) => (
            <span key={c.key}
                  className="inline-flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-[11px] font-medium text-sky-900">
              {c.label}
              <button onClick={() => setFilters((f) => clearOne(f, c.key))}
                      aria-label={`Remove ${c.label}`}
                      className="ml-0.5 text-sky-400 hover:text-red-500">
                <X size={11} />
              </button>
            </span>
          ))}
          {yearsWithoutData.length > 0 && (
            <span
              title="No loans are loaded for this year. The filter stays on it on purpose: silently falling back to another year would show correct figures for a period nobody asked for."
              className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-800"
            >
              No data for {yearsWithoutData.join(", ")}
            </span>
          )}
          {chips.length > 0 && (
            // Clear all devuelve el año en curso, no lo vacia: "todos los años"
            // no es el estado con el que se entra ni el que se quiere al
            // limpiar.
            <button onClick={() => setFilters(initialFilters())}
                    className="text-xs text-gray-400 underline hover:text-gray-600">
              Clear all
            </button>
          )}

          {data && filteredRows.length > 0 && (
            <button
              onClick={handleExport}
              className="ml-auto flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 shadow-sm"
            >
              <Download size={13} /> Export Excel
            </button>
          )}
        </div>

        {filtersOpen && (
          <div className="rounded-xl border border-gray-200 bg-gray-50/60 p-3">
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-3 lg:grid-cols-4">
              <Facet label="Year"         k="year"         f={filters} set={setFilters} o={facetOptions} c={facetCounts} />
              <Facet label="Month"        k="month"        f={filters} set={setFilters} o={facetOptions} c={facetCounts} />
              <Facet label="Branch"       k="branch"       f={filters} set={setFilters} o={facetOptions} c={facetCounts} search />
              <Facet label="Loan officer" k="loanOfficer"  f={filters} set={setFilters} o={facetOptions} c={facetCounts} search />
              <Facet label="Loan program" k="loanProgram"  f={filters} set={setFilters} o={facetOptions} c={facetCounts} search />
              <Facet label="Lead source"  k="leadSource"   f={filters} set={setFilters} o={facetOptions} c={facetCounts} search />
              <Facet label="Channel"      k="channel"      f={filters} set={setFilters} o={facetOptions} c={facetCounts} />
              <Facet label="Status"       k="status"       f={filters} set={setFilters} o={facetOptions} c={facetCounts} />

              <TextFacet label="Loan number" k="loanNumber" f={filters} set={setFilters} />
              <TextFacet label="Borrower"    k="borrower"   f={filters} set={setFilters} />

              <RangeFacet label="Loan amount"     k="loanAmount"     f={filters} set={setFilters} />
              <RangeFacet label="Division margin" k="divisionMargin" f={filters} set={setFilters} />
              <RangeFacet label="Branch margin"   k="branchMargin"   f={filters} set={setFilters} />
              <RangeFacet label="LO commission"   k="loCommission"   f={filters} set={setFilters} />
            </div>
            <p className="mt-3 text-[11px] text-gray-500">
              Dropdown options and counts come from every loaded loan, not from what is already
              filtered — so narrowing one column never empties another.{" "}
              <span className="font-medium text-gray-600">{NO_VALUE}</span> isolates the loans where
              the field is empty; for amounts, <span className="font-medium text-gray-600">no value</span>{" "}
              is a separate checkbox from a 0 — a loan with no booking and one booked at 0.00 are
              different findings.
            </p>
          </div>
        )}
      </div>

      {loading ? (
        <div className="py-12 text-center">
          <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-blue-300 border-t-blue-600" />
        </div>
      ) : error ? (
        <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-xs text-red-600">{error}</div>
      ) : data ? (
        <>
          {/* Metric cards */}
          {/* Cuatro y no tres: "Avg BPS" a secas dejo de significar algo al
              separar los dos margenes. Uno ronda los 65 -- es un baremo -- y el
              otro los 350. Una sola tarjeta tendria que elegir cual esconde. */}
          <div className="grid grid-cols-4 gap-3">
            <MetricCard label="Loan Count" value={loanCount.toLocaleString()} />
            <MetricCard label="Avg Loan Amount" value={avgLoanAmount != null ? fmtUSD(avgLoanAmount) : "—"} />
            <MetricCard label="Avg division BPS" value={avgBPS != null ? fmtBPS(avgBPS) : "—"} />
            <MetricCard label="Avg branch BPS" value={avgBranchBPS != null ? fmtBPS(avgBranchBPS) : "—"} />
          </div>

          <DetailView rows={filteredRows} />

          {showSurplus && <SurplusSection rows={data.surplus} />}
        </>
      ) : null}
    </div>
  );
}

// ─── Loan Validation Tab (root export) ───────────────────────────────────────

export function LoanValidationTab() {
  const { activeBranches } = useActiveBranches();

  /**
   * Ya no queda barra de filtros aqui.
   *
   * Tenia Month, Year, Branch, una caja de numero de prestamo y un Clear. Los
   * tres primeros solo servian a B2B --All Loans los tiene en su panel-- y la
   * caja de numero era un segundo camino al mismo filtro que el panel ya
   * ofrece: dos controles para una cosa es lo que produjo el fallo del año.
   *
   * Lo unico que sobrevive es el aviso del filtro global, que no es un control
   * sino una advertencia: esta pantalla filtra por la sucursal que PRODUJO el
   * prestamo y el filtro global nombra sucursales contables, asi que no aplica
   * aqui. Sin decirlo, alguien con la 716 puesta lee estos numeros como si
   * fueran de la 716.
   */
  return (
    <div className="flex flex-col gap-4">
      {activeBranches.length > 0 && (
        <div className="flex items-center gap-3 flex-wrap">
          <span
            title="This screen filters by the branch that produced the loan; the global filter names accounting branches."
            className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-[10px] text-slate-600"
          >
            global branch filter ({activeBranches.join(", ")}) does not apply here
          </span>
        </div>
      )}

      {/* Sin conmutador: con B2B fuera, All Loans no es un sub-tab de dos -- es
          la pantalla. */}
      <AllLoansSection />
    </div>
  );
}
