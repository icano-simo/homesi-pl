/**
 * ─────────────────────────────────────────────────────────────────────────────
 * LAS SEIS CATEGORIAS EN QUE SE PARTE "LOAN OFFICER PAYROLL"
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Hasta ahora la pantalla enseñaba una sola cifra por persona --la suma de las
 * cuentas de produccion del P&L-- y al lado la comision. Cuando no cuadraban,
 * y casi nunca cuadran, no habia manera de saber por que. Compensafe lo sabe
 * linea a linea: `comp.payroll_transaction`, 1.859 lineas al 2026-09-17.
 *
 *     Commission           549 lineas   1.288.545,29
 *     Hourly wages         564            767.849,62
 *     Bonus                264            574.390,78
 *     Earnings recapture   252           -203.613,77
 *     Override              34             39.412,16
 *     Salary               196            473.794,98
 *                                       ─────────────
 *                                        2.940.379,06
 *
 * ⚠ EL ORDEN DE LA CLASIFICACION IMPORTA Y NO ES ARBITRARIO. `is_recapture` va
 * ANTES que `is_hourly` porque las 251 lineas de recuperacion de horas llevan
 * LAS DOS banderas a true. Al reves contarian como horas cobradas, cuando son
 * devoluciones: 203.363,77 cambiando de signo.
 *
 * ⚠ Y LAS HORAS SE CUENTAN POR `is_hourly`, NUNCA POR `gl_code_credit`. Esa
 * columna solo cubre 2026 --Compensafe empezo a clasificar entonces y las 311
 * lineas de horas de 2025 quedaron sin categoria-- asi que contar por ella
 * pierde un año entero sin que nada falle: el numero solo sale mas pequeño.
 * Ver el comentario de esa columna en Supabase.
 */

export type PayrollCategory =
  | "commission"
  | "hourly"
  | "recapture"
  | "bonus"
  | "override"
  | "salary";

/** Una linea de `comp.payroll_transaction`, en lo que hace falta para clasificar. */
export interface ClassifiableLine {
  pay_type: string | null;
  is_hourly: boolean | null;
  is_recapture: boolean | null;
}

/**
 * ⚠ EL ORDEN DE ESTOS `if` ES LA REGLA, no una preferencia de estilo. Cambiarlo
 * cambia los numeros. En particular `is_recapture` antes que `is_hourly`.
 */
export function categoriaDe(r: ClassifiableLine): PayrollCategory {
  if (r.pay_type === "Commission") return "commission";
  if (r.is_recapture) return "recapture";
  if (r.is_hourly) return "hourly";
  if (r.pay_type === "Bonus") return "bonus";
  if (r.pay_type === "Override") return "override";
  return "salary";
}

/** Lo acumulado de una persona en un periodo. Todas las claves siempre presentes. */
export type PayrollBreakdown = Record<PayrollCategory, number>;

export const BREAKDOWN_CERO = (): PayrollBreakdown => ({
  commission: 0, hourly: 0, recapture: 0, bonus: 0, override: 0, salary: 0,
});

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠ SOLO TRES DE LAS SEIS ENTRAN EN LA COMPARACION CONTRA EL P&L
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * La comparacion enfrenta lo que Compensafe dice que se pago contra lo que el
 * P&L tiene en las cuentas de produccion (60105, 60115, 60117). Meter en ella
 * una categoria que NO se contabiliza ahi no la completa: la descuadra.
 *
 * MEDIDO el 2026-09-17 ejecutando el emparejador real sobre las dos fuentes,
 * 51 personas presentes en las dos:
 *
 *   OVERRIDE -- FUERA. CERO de las 51 personas con override aparece en la
 *   nomina de produccion. No es que cuadre mal: es que nunca esta ahi. Se le
 *   paga al manager del loan officer y va por otra cuenta.
 *
 *   BONUS -- FUERA, y es el caso que parecia dudoso. De las 23 personas con
 *   bonus, sumarlo ACERCA en 8 y ALEJA en 15. Los dos casos limpios lo zanjan:
 *   Daniella Ottone y Kelvin Flores Aguilera cuadran EXACTO --desvio cero--
 *   sin el bonus, y al sumarlo se rompen por exactamente su bonus. En sentido
 *   contrario solo Aileen Perez Rodriguez. O sea que a veces SI se contabiliza
 *   ahi y a veces no; mientras no se sepa cuando, meterlo rompe a 15 para
 *   arreglar a 8.
 *
 *   SALARY -- FUERA, y esta ya estaba decidida antes. Son 196 lineas de 16
 *   personas, y casi ninguna es loan officer: Regional Manager, Branch
 *   Managers, Divisional Growth Leader. Su sueldo va por 60112 y 60126, que
 *   `PRODUCTION_PAY_GL_CODES` excluye A PROPOSITO por ser sueldo fijo y no
 *   pago por produccion. Sumarlo desviaria el Difference de cualquier branch
 *   manager por su sueldo entero.
 *
 * ⚠ LAS TRES SE SIGUEN VIENDO, debajo y fuera de la suma, con el mismo patron
 * que "Not part of this branch's contribution". Que no cuenten no significa
 * que no existan: son 1.087.597,92 que alguien cobro.
 */
export const EN_LA_COMPARACION: readonly PayrollCategory[] = [
  "commission",
  "hourly",
  "recapture",
];

export const FUERA_DE_LA_COMPARACION: readonly PayrollCategory[] = [
  "bonus",
  "override",
  "salary",
];

export const ETIQUETA: Record<PayrollCategory, string> = {
  commission: "Commission on loans · by closing month",
  hourly: "Hourly wages",
  recapture: "Earnings recapture",
  bonus: "Bonus",
  override: "Override",
  salary: "Salary",
};

export const EXPLICACION: Record<PayrollCategory, string> = {
  commission:
    "What Compensafe paid this person for closing loans.",
  hourly:
    "Hours paid every half-month. Counted by the source's own is_hourly flag — the pay category column only classifies from 2026 on, so counting by it would drop a whole year of history.",
  recapture:
    "Hours paid in advance that were taken back when a loan closed. Negative because it is money returned, not money paid.",
  bonus:
    "Not added above: measured over 51 people, adding the bonus moves 8 closer to the P&L account and 15 further away. Two people match to the cent without it and break by exactly their bonus with it.",
  override:
    "Not added above: none of the people with an override appear in the production payroll accounts at all. It is paid to the loan officer's manager, through another account.",
  salary:
    "Not added above: fixed salary is booked to 60112 and 60126, which the production accounts deliberately exclude. Almost everyone here is a manager, not a loan officer.",
};

/** La suma que se enfrenta al P&L. Solo las tres de arriba. */
export function totalComparable(b: PayrollBreakdown): number {
  return EN_LA_COMPARACION.reduce((s, c) => s + b[c], 0);
}

/** Lo que se enseña pero no cuenta. */
export function totalFuera(b: PayrollBreakdown): number {
  return FUERA_DE_LA_COMPARACION.reduce((s, c) => s + b[c], 0);
}
