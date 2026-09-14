import type { ValidationRow } from "@/app/api/loan-validation/route";

/**
 * Los filtros por columna de Loan Validation.
 *
 * Viven aqui y no dentro del componente por dos razones: la pantalla ya tiene
 * mil lineas, y esto se puede leer entero sin JSX alrededor -- que es lo que
 * hace falta cuando alguien dude de por que una fila aparece o no.
 *
 * ─── ⚠ LOS VACIOS SON FILTRABLES, Y ES EL REQUISITO CENTRAL ────────────────
 *
 * Encontrar lo que falta es lo que esta pantalla existe para hacer. Un prestamo
 * sin lead source, sin programa o sin margen es un hallazgo, y hasta ahora no
 * se podia aislar. Cada desplegable ofrece NO_VALUE y cada rango una casilla de
 * "solo vacios".
 *
 * Medido sobre los 436:
 *   sin loan_program      57      sin division margin   76
 *   sin lead_source       46      sin branch margin     78
 *                                 sin LO commission    129
 *
 * ─── ⚠ VACIO Y CERO NO SON LO MISMO EN LOS IMPORTES ────────────────────────
 *
 * Un prestamo SIN apunte de margen y uno con un apunte de 0,00 son hallazgos
 * distintos: el primero es "nadie lo contabilizo", el segundo es "se
 * contabilizo y dio cero". Es la misma distincion que ya se defendio en
 * dm_total, y un rango min=0 max=0 los mezclaria en un solo cubo.
 *
 * Por eso `emptyOnly` es una casilla aparte del rango y no un valor del rango.
 */

/** El valor que representa "sin valor" en un desplegable. */
export const NO_VALUE = "(No value)";

export interface RangeFilter {
  min: string;
  max: string;
  /** Solo las filas SIN apunte. Excluyente con el rango: ver la nota. */
  emptyOnly: boolean;
}

export const EMPTY_RANGE: RangeFilter = { min: "", max: "", emptyOnly: false };

export interface LoanValidationFilters {
  year: string[];
  month: string[];
  branch: string[];
  loanProgram: string[];
  leadSource: string[];
  channel: string[];
  loanOfficer: string[];
  status: string[];
  /** Texto: son identificadores, un desplegable de 436 valores no ayuda. */
  loanNumber: string;
  borrower: string;
  loanAmount: RangeFilter;
  divisionMargin: RangeFilter;
  branchMargin: RangeFilter;
  loCommission: RangeFilter;
}

export const EMPTY_FILTERS: LoanValidationFilters = {
  year: [], month: [], branch: [], loanProgram: [], leadSource: [],
  channel: [], loanOfficer: [], status: [],
  loanNumber: "", borrower: "",
  loanAmount: EMPTY_RANGE, divisionMargin: EMPTY_RANGE,
  branchMargin: EMPTY_RANGE, loCommission: EMPTY_RANGE,
};

/**
 * Con que filtros se entra: el año EN CURSO, calculado de la fecha de hoy.
 *
 * No una constante -- caduca el 1 de enero, que es el "diciembre" fijo de
 * /start otra vez -- ni "el ultimo año con datos", que en enero deja la
 * pantalla mirando al año pasado justo cuando mas importa ver que el nuevo
 * empezo vacio.
 *
 * ⚠ ES UN FILTRO DE CLIENTE, no del endpoint. El endpoint carga TODOS los
 * periodos a proposito: si cargara solo el año elegido, las opciones de cada
 * desplegable saldrian de un conjunto ya recortado y el desplegable de año solo
 * se ofreceria a si mismo. Eso es exactamente el encierro que paso al empezar,
 * y la razon de que las opciones vengan del conjunto completo.
 */
export function initialFilters(now: Date = new Date()): LoanValidationFilters {
  return { ...EMPTY_FILTERS, year: [String(now.getFullYear())] };
}

/** El texto de una columna de texto, con el vacio normalizado a NO_VALUE. */
const val = (v: string | number | null | undefined): string => {
  const s = v == null ? "" : String(v).trim();
  return s === "" ? NO_VALUE : s;
};

/** Los importes de cada fila, uno por columna filtrable. Null = sin apunte. */
const amountOf = (r: ValidationRow): Record<string, number | null> => ({
  loanAmount: r.loan_amount,
  divisionMargin: r.division_total,
  branchMargin: r.branch_margin_total,
  loCommission: r.lo_commission,
});

/** Cada fila, reducida a los valores por los que se puede filtrar. */
export function facetsOf(r: ValidationRow): Record<string, string> {
  return {
    year: val(r.year),
    month: val(r.month),
    branch: val(r.branch),
    loanProgram: val(r.loan_program),
    leadSource: val(r.lead_source),
    channel: val(r.loan_info_channel),
    loanOfficer: val(r.loan_officer),
    status: r.status === "missing" ? "Missing" : "Match",
  };
}

function rangeAllows(f: RangeFilter, v: number | null): boolean {
  if (f.emptyOnly) return v === null;
  if (v === null) {
    // Con un rango puesto, una fila sin apunte NO entra: no se puede afirmar
    // que un importe ausente este entre dos numeros. Sin rango, entra.
    return f.min === "" && f.max === "";
  }
  if (f.min !== "" && v < Number(f.min)) return false;
  if (f.max !== "" && v > Number(f.max)) return false;
  return true;
}

/** Una fila pasa si pasa TODOS los filtros. */
export function rowMatches(r: ValidationRow, f: LoanValidationFilters): boolean {
  const fa = facetsOf(r);
  const sel: [keyof LoanValidationFilters, string][] = [
    ["year", fa.year], ["month", fa.month], ["branch", fa.branch],
    ["loanProgram", fa.loanProgram], ["leadSource", fa.leadSource],
    ["channel", fa.channel], ["loanOfficer", fa.loanOfficer], ["status", fa.status],
  ];
  for (const [key, v] of sel) {
    const chosen = f[key] as string[];
    if (chosen.length > 0 && !chosen.includes(v)) return false;
  }

  const q = f.loanNumber.trim().toLowerCase();
  if (q && !r.loan_number.toLowerCase().includes(q)) return false;
  const b = f.borrower.trim().toLowerCase();
  if (b && !(r.borrower_name ?? "").toLowerCase().includes(b)) return false;

  const amounts = amountOf(r);
  for (const key of ["loanAmount", "divisionMargin", "branchMargin", "loCommission"] as const) {
    if (!rangeAllows(f[key], amounts[key])) return false;
  }
  return true;
}

/**
 * Opciones y conteos de cada desplegable, SOBRE EL CONJUNTO COMPLETO.
 *
 * ⚠ No sobre lo ya filtrado, y la diferencia importa: si las opciones salieran
 * de lo filtrado, elegir una sucursal vaciaria el desplegable de programas y el
 * usuario no podria volver atras sin limpiar todo. Es la decision que ya se
 * tomo en Metrics B2B, por la misma razon.
 *
 * El conteo es de cuantas filas del conjunto llevan ese valor, no de cuantas
 * quedarian combinando con los demas filtros -- que dependeria del orden en que
 * se pulsan y no seria estable mientras el panel esta abierto.
 */
export function buildFacetOptions(rows: ValidationRow[]): {
  options: Record<string, string[]>;
  counts: Record<string, Record<string, number>>;
} {
  const keys = ["year", "month", "branch", "loanProgram", "leadSource", "channel", "loanOfficer", "status"];
  const counts: Record<string, Record<string, number>> = {};
  for (const k of keys) counts[k] = {};

  for (const r of rows) {
    const fa = facetsOf(r);
    for (const k of keys) counts[k][fa[k]] = (counts[k][fa[k]] ?? 0) + 1;
  }

  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const options: Record<string, string[]> = {};
  for (const k of keys) {
    const vs = Object.keys(counts[k]);
    const real = vs.filter((v) => v !== NO_VALUE);
    if (k === "month") real.sort((a, b) => MONTHS.indexOf(a) - MONTHS.indexOf(b));
    else if (k === "year") real.sort((a, b) => Number(b) - Number(a));
    else real.sort((a, b) => a.localeCompare(b));
    // NO_VALUE primero: es lo que se viene a buscar, no un resto al final.
    options[k] = vs.includes(NO_VALUE) ? [NO_VALUE, ...real] : real;
  }
  return { options, counts };
}

/** Los filtros activos, para pintarlos como chips y poder quitarlos uno a uno. */
export function activeChips(f: LoanValidationFilters): { key: keyof LoanValidationFilters; label: string }[] {
  const out: { key: keyof LoanValidationFilters; label: string }[] = [];
  const named: [keyof LoanValidationFilters, string][] = [
    ["year", "Year"], ["month", "Month"], ["branch", "Branch"],
    ["loanProgram", "Loan program"], ["leadSource", "Lead source"],
    ["channel", "Channel"], ["loanOfficer", "Loan officer"], ["status", "Status"],
  ];
  for (const [k, name] of named) {
    const v = f[k] as string[];
    if (v.length > 0) out.push({ key: k, label: `${name}: ${v.length === 1 ? v[0] : `${v.length} selected`}` });
  }
  if (f.loanNumber.trim()) out.push({ key: "loanNumber", label: `Loan number: ${f.loanNumber.trim()}` });
  if (f.borrower.trim()) out.push({ key: "borrower", label: `Borrower: ${f.borrower.trim()}` });

  const ranges: [keyof LoanValidationFilters, string][] = [
    ["loanAmount", "Loan amount"], ["divisionMargin", "Division margin"],
    ["branchMargin", "Branch margin"], ["loCommission", "LO commission"],
  ];
  for (const [k, name] of ranges) {
    const r = f[k] as RangeFilter;
    if (r.emptyOnly) out.push({ key: k, label: `${name}: no value` });
    else if (r.min !== "" || r.max !== "") {
      out.push({ key: k, label: `${name}: ${r.min || "…"} — ${r.max || "…"}` });
    }
  }
  return out;
}

/** Deja un solo filtro en blanco, conservando los demas. */
export function clearOne(f: LoanValidationFilters, key: keyof LoanValidationFilters): LoanValidationFilters {
  const blank = EMPTY_FILTERS[key];
  return { ...f, [key]: Array.isArray(blank) ? [] : blank };
}
