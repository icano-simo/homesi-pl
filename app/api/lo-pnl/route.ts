import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { MARGIN_ALL_GL_LIST } from "@/lib/loan-detail-accounts";
import { closePeriod } from "@/lib/close-period";
import {
  findCollapsedPairs,
  findSplitByShape,
  matchDescription,
  normalizeName,
  parseDescription,
  SHAPES_IN_TOTAL,
  type CollapsedPair,
  type SplitByShape,
  type DescriptionShape,
  type KnownPerson,
  type MatchMethod,
} from "@/lib/lo-payroll-name";

export const dynamic = "force-dynamic";

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * P&L POR LOAN OFFICER
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Contesta una sola pregunta: ¿esta persona se paga sola?
 *
 * Dos bloques, y LO QUE LOS SEPARA ES SI LA TRANSACCION TIENE loan_number, no
 * de que cuenta sale. Esa distincion es la regla, y se eligio sobre una lista
 * cerrada de cuentas por un caso concreto: Jose Arango tiene 16.836,19 de coste
 * y 2.494 de ellos --el 15%-- son portatil, McAfee, Office365, licencias y
 * telefono, en cuentas que ninguna lista de nomina habria incluido. En alguien
 * con cero cierres, ese 15% es justo lo que el modulo debe enseñar.
 *
 *   BLOQUE 1, con loan_number: los prestamos que cerro. Su margen, sus costes
 *     de prestamo, y la comision que se le pago por cada uno.
 *   BLOQUE 2, sin loan_number: lo que cuesta la persona. Salario, bonos,
 *     impuestos, seguros, equipo, licencias -- salga de donde salga.
 *
 * TOTAL = bloque 1 menos bloque 2, ENTERO. Impuestos y seguros incluidos: un
 * impuesto de nomina es dinero que sale igual que un salario, y dejarlo fuera
 * daria un resultado mejor que el real, que es la unica clase de error que este
 * modulo no se puede permitir.
 *
 * Si no produjo nada, el total es lo que costo, en negativo. Ese caso TIENE que
 * verse: Jose Arango no cerro un solo prestamo.
 */

// ─── El censo de personas ─────────────────────────────────────────────────────

interface Censo {
  people: KnownPerson[];
  /** El espejo de person_name_key existe y trae filas. */
  hasNameKey: boolean;
  /** Por que no, cuando no. Va a la pantalla; un dato que falta se dice. */
  nameKeyNote: string | null;
}

/**
 * Junta todas las grafias conocidas de cada persona.
 *
 * ⚠ CINCO FUENTES Y NINGUNA SOBRA. Se midio: `person_name_key` sola resuelve 28
 * de los 46 loan officers y la normalizacion contra el roster 31; unidas, 34.
 * `dim_person`, base de person_name_key, tiene 111 personas y el roster 114, asi
 * que 18 de los 46 solo aparecen por el lado del roster. Quitar una fuente
 * "porque la otra la cubre" pierde gente, y el sintoma --"sin nomina
 * localizada"-- se lee como hallazgo del negocio y no como regresion.
 */
async function cargarCenso(): Promise<Censo> {
  const org = createServerClient("org");
  const porCodigo = new Map<string, { display: string; keys: Set<string> }>();
  const sueltas = new Map<string, { display: string; keys: Set<string> }>();

  const add = (code: string | null, display: string | null, ...nombres: (string | null)[]) => {
    const claves = nombres.map(normalizeName).filter(Boolean);
    if (claves.length === 0) return;
    const nombre = display?.trim() || claves[0];
    // Sin person_code la persona no se puede fusionar con otra fuente, asi que
    // se agrupa por su propia clave. Es peor que tener codigo, y es lo que hay
    // para los 18 que no estan en dim_person.
    const mapa = code ? porCodigo : sueltas;
    const llave = code ?? claves[0];
    const ent = mapa.get(llave) ?? { display: nombre, keys: new Set<string>() };
    claves.forEach((k) => ent.keys.add(k));
    if (!ent.display) ent.display = nombre;
    mapa.set(llave, ent);
  };

  let hasNameKey = false;
  let nameKeyNote: string | null = null;

  // 1. person_name_key: lo unico que sabe que "steve" y "steven" son la misma
  //    persona. Puede no existir todavia -- la escribe simo-sync -- y su
  //    ausencia NO puede tumbar la pantalla, solo baja la tasa de 34 a 31.
  try {
    const { data, error } = await org
      .from("person_name_key")
      .select("person_code,name_key")
      .range(0, 999);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      add(r.person_code as string, null, r.name_key as string);
    }
    hasNameKey = (data?.length ?? 0) > 0;
    if (!hasNameKey) nameKeyNote = "org.person_name_key existe pero esta vacia";
  } catch (e) {
    nameKeyNote = `org.person_name_key no disponible (${e instanceof Error ? e.message : "?"})`;
  }

  /*
   * 2. El roster y la identidad de la app. Aqui estan los 18 que dim_person no
   *    tiene, y por eso estas tres no se pueden retirar "porque ya esta
   *    person_name_key".
   *
   * Cada una en su llamada y no en un bucle: la lista de columnas de
   * supabase-js es un tipo literal, asi que pasarla como variable pierde el
   * tipado y el compilador deja de avisar si alguien renombra una columna.
   *
   * Cada try suelto por la misma razon que el de person_name_key: una fuente
   * que falta baja la tasa de acierto, no tumba la pantalla.
   */
  try {
    const { data, error } = await org
      .from("roster_current")
      .select("person_code,display_name,name_in_file")
      .range(0, 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) {
      add(r.person_code, r.display_name, r.display_name, r.name_in_file);
    }
  } catch { /* baja la tasa, no rompe */ }

  /*
   * ⚠ NO SE LEEN `org.dim_employee` NI `org.employee_alias`, Y SE MIDIO ANTES
   * DE DECIDIRLO.
   *
   * `service_role` no tiene SELECT sobre ninguna de las dos --los GRANT de `org`
   * se dieron tabla por tabla y esas dos nunca se abrieron--, asi que leerlas
   * desde aqui devuelve "permission denied" en cada carga.
   *
   * Y pedir el permiso no compensa: de los 11 loan officers que hoy quedan sin
   * nomina localizada, esas dos tablas solo aportarian clave para DOS --Adriana
   * Julieth Szczech y Julymar Mar Castro-- que son exactamente los dos que
   * person_name_key ya resuelve. Ademas `employee_alias` se llavea por
   * `employee_key`, asi que sin abrir tambien `dim_employee` no se puede
   * traducir a `person_code`: serian dos permisos nuevos para cero personas
   * mas.
   *
   * Si algun dia se abren, aqui van dos bloques mas como los de arriba.
   */

  try {
    const { data, error } = await org
      .from("loan_officer_resolved")
      .select("person_code,nombre_canonico,loan_officer_name")
      .range(0, 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) {
      add(r.person_code, r.nombre_canonico, r.nombre_canonico, r.loan_officer_name);
    }
  } catch { /* baja la tasa, no rompe */ }

  const conCodigo: KnownPerson[] = [...porCodigo.entries()].map(([personCode, v]) => ({
    personCode,
    displayName: v.display,
    keys: [...v.keys],
  }));

  /*
   * ⚠ FUSIONAR LAS SUELTAS CON SU DUEÑO, O SE PIERDE GENTE.
   *
   * Un fallo encontrado ejecutando, no leyendo: `org.loan_officer_resolved`
   * tiene 87 nombres y solo 54 con `person_code`, asi que Ludwig Aguillon
   * entraba DOS VECES al censo -- una desde roster_current con su codigo y otra
   * desde loan_officer_resolved sin el. Las dos con la misma clave
   * "ludwig aguillon".
   *
   * Y entonces matchDescription hacia exactamente lo que se le pide: veia dos
   * candidatos, declaraba ambiguo y no elegia ninguno. Resultado: se perdia a
   * quien esta en DOS fuentes, que es justo al reves de lo que deberia pasar.
   * En la corrida de prueba se llevo por delante a Ludwig Aguillon y su nomina
   * quedaba en "sin localizar", que se lee como un hallazgo.
   *
   * La regla de fusion es la misma disciplina de siempre: una suelta se pega a
   * una persona con codigo SOLO si comparte clave con exactamente una. Con dos
   * o mas se queda aparte, porque entonces la ambiguedad es real.
   */
  const sinDueño: KnownPerson[] = [];
  for (const v of sueltas.values()) {
    const claves = [...v.keys];
    const dueños = conCodigo.filter((p) => claves.some((k) => p.keys.includes(k)));
    if (dueños.length === 1) {
      claves.forEach((k) => {
        if (!dueños[0].keys.includes(k)) (dueños[0].keys as string[]).push(k);
      });
    } else {
      sinDueño.push({ personCode: null, displayName: v.display, keys: claves });
    }
  }

  return { people: [...conCodigo, ...sinDueño], hasNameKey, nameKeyNote };
}

// ─── Lo que devuelve ──────────────────────────────────────────────────────────

export interface LoanLine {
  gl_code: string | null;
  gl_name: string | null;
  amount: number;
  is_margin: boolean;
}

export interface LoanRow {
  loan_number: string;
  month: string | null;
  year: number | null;
  branch: string | null;
  loan_amount: number | null;
  /** Las cinco cuentas de margen. Misma definicion que Loan Validation. */
  margin: number;
  /** Todo lo demas del prestamo: Lender Credits, Cures, Processing Fees... */
  other: number;
  /**
   * Lo que se le pago al loan officer por ESTE prestamo, de comp.loan_commission.
   * Null cuando el prestamo no cruza, que NO es cero.
   */
  commission: number | null;
  /** margin + other - commission. Null si la comision no se conoce. */
  net: number | null;
  lines: LoanLine[];
}

export interface PayrollRow {
  check_description: string;
  gl_code: string | null;
  gl_name: string | null;
  month: string | null;
  year: number | null;
  amount: number;
  shape: DescriptionShape;
  method: MatchMethod | null;
  /** Llegaba en el limite de 35 caracteres: el nombre puede venir cortado. */
  truncated: boolean;
}

export type PayrollStatus =
  /** Hay nomina y esta atribuida. */
  | "located"
  /** No hay NI UNA fila con su nombre en todo el P&L. No es cero: es vacio. */
  | "not_located"
  /** Solo aparece en formas de atribucion menos fiable. */
  | "fragile_only";

export interface OfficerBlock {
  name: string;
  personCode: string | null;
  branch: string | null;

  // ── Bloque 1 ──
  loans: LoanRow[];
  loanCount: number;
  volume: number;
  block1Margin: number;
  block1Other: number;
  /** Suma de las comisiones conocidas. */
  block1Commission: number;
  /** Prestamos cuya comision no cruzo. Se dice; no se cuenta como cero. */
  loansWithoutCommission: number;
  block1Net: number;

  // ── Bloque 2 ──
  payroll: PayrollRow[];
  /** Formas menos fiables. NO suman en block2 ni en el total. */
  payrollFragile: PayrollRow[];
  block2Total: number;
  block2FragileTotal: number;
  payrollStatus: PayrollStatus;
  /** Filas suyas que venian truncadas, para poder decir cuanto se fia uno. */
  truncatedRows: number;

  // ── Total ──
  /** block1Net + block2Total. La comision NO entra: ver la nota de block1Net. */
  total: number;
  /**
   * Cobra en alguna cuenta de compensacion del P&L.
   *
   * Cuando es true, la comision de esta persona ya viaja dentro del bloque 2 y
   * por eso no se resta aparte. `block1Commission` se enseña igualmente, como
   * referencia de cuanto de ese pago fue por prestamos.
   *
   * ⚠ "ALGUNA CUENTA", no 60105. Un branch manager que produce cobra en 60115
   * Personal Production y un sales manager en 60117, no en la cuenta de loan
   * officer. Preguntar solo por 60105 los deja a todos fuera.
   */
  commissionInPayroll: boolean;
  /**
   * ⚠ TIENE COMISION Y NINGUNA FILA EN NINGUNA CUENTA DE COMPENSACION.
   *
   * Entonces ese pago no esta en el P&L, el bloque 2 se queda corto y el total
   * sale MEJOR que la realidad, que es el error que este modulo no se puede
   * permitir. No se corrige inventando un apunte -- se dice.
   *
   * MEDIDO el 2026-09-14, y son DOS personas con 17.509,57:
   *
   *     silvio.arteaga   16.013,58
   *     susan.aguilar     1.495,99
   *
   * Las dos tienen gasto suelto --el asiento de Salesforce-- pero ni sueldo, ni
   * comision, ni impuestos. Ninguna de las 28 personas con comision se queda sin
   * NI UNA fila en todo el P&L.
   *
   * ⚠ LA PRIMERA MEDICION DIJO DIEZ PERSONAS Y 468.184,75, y era falsa: pregunto
   * solo por 60105. Ocho de aquellas diez son branch y sales managers que
   * producen y cobran en su propia cuenta. Se deja escrito porque el numero malo
   * era alarmante y plausible a la vez, que es la peor combinacion.
   */
  commissionOutsidePayroll: boolean;
}

export interface LoPnlResult {
  officers: OfficerBlock[];
  /** Nomina que no se pudo atribuir a nadie. Nunca se reparte ni se oculta. */
  unattributed: { rows: PayrollRow[]; total: number };
  collapsedPairs: CollapsedPair[];
  /** La misma persona enseñada como dos filas. Ver findSplitByShape. */
  splitByShape: SplitByShape[];
  period: { month: string | null; year: number | null; all: boolean };
  /** Sin el espejo de person_name_key la tasa baja de 34/46 a 31/46. */
  nameKeyAvailable: boolean;
  nameKeyNote: string | null;
  /**
   * Comision que NO aparece en la nomina del P&L, sumada.
   *
   * No es una advertencia generica: es cuanto dinero salio de verdad y este
   * modulo no puede ver por la via de 60105. Por ese importe, los totales de
   * esas personas salen mejores que la realidad.
   */
  commissionOutsidePayrollTotal: number;
}

// ─── Paginacion ───────────────────────────────────────────────────────────────

/** PostgREST corta en 1000. Una opcion que falta por eso parece un filtro roto. */
async function paginar<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  build: () => any,
): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    out.push(...(data as T[]));
    if (data.length < PAGE) break;
  }
  return out;
}

// ─── La ruta ──────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const supabase = createServerClient();
  const { searchParams } = new URL(req.url);

  /*
   * Por defecto el mes de cierre, el mismo que /start: se calcula del reloj y no
   * del dato. Elegir "el periodo mas nuevo cargado" haria que la pantalla
   * cambiara de tema sola en cuanto entrara un archivo.
   */
  const all = searchParams.get("all") === "1";
  const def = closePeriod();
  const month = all ? null : searchParams.get("month") ?? def.month;
  const year = all ? null : Number(searchParams.get("year") ?? def.year);

  // ── 1. Los prestamos del periodo ───────────────────────────────────────────
  const officials = await paginar<Record<string, unknown>>(() => {
    let q = supabase
      .from("loan_officials")
      .select("loan_number,loan_officer,branch,loan_amount,month,year");
    if (month) q = q.eq("month", month);
    if (year) q = q.eq("year", year);
    return q;
  });

  const loanNumbers = [
    ...new Set(officials.map((o) => (o.loan_number as string)?.trim()).filter(Boolean)),
  ];

  // ── 2. Las lineas del P&L de esos prestamos ────────────────────────────────
  //
  // El margen se pide con MARGIN_ALL_GL_LIST, la MISMA lista que Loan
  // Validation. No hay una segunda definicion de margen aqui: lib/
  // loan-detail-accounts.ts es su unica casa, y por que son tres definiciones
  // distintas esta escrito alli.
  const CHUNK = 200;
  const loanLines: Record<string, unknown>[] = [];
  for (let i = 0; i < loanNumbers.length; i += CHUNK) {
    const trozo = loanNumbers.slice(i, i + CHUNK);
    loanLines.push(
      ...(await paginar<Record<string, unknown>>(() =>
        supabase
          .from("pl_transactions")
          .select("loan_number,gl_code,gl_name,movement")
          .in("loan_number", trozo),
      )),
    );
  }

  // ── 3. La comision, de comp ────────────────────────────────────────────────
  //
  // ⚠ QUE FALLE NO PUEDE TUMBAR LA PANTALLA. El modulo funciona sin Compensafe:
  // sin ella las comisiones salen null --que es "no se sabe", no "cero"-- y el
  // resto se ve igual.
  const commissionByLoan = new Map<string, number>();
  const commissionByPerson = new Map<string, number>();
  try {
    const comp = createServerClient("comp");
    const filas = await paginar<Record<string, unknown>>(() =>
      comp.from("loan_commission").select("loan_number,lo_pay,lo_name"),
    );
    for (const r of filas) {
      if (r.lo_pay != null) commissionByLoan.set(r.loan_number as string, Number(r.lo_pay));
      // lo_name viene en "Apellido, Nombre", el MISMO formato que la nomina del
      // P&L, asi que el mismo parser sirve para los dos lados.
      const p = parseDescription(r.lo_name as string);
      if (p.key) {
        commissionByPerson.set(p.key, (commissionByPerson.get(p.key) ?? 0) + Number(r.lo_pay ?? 0));
      }
    }
  } catch (e) {
    console.error("[lo-pnl] comp.loan_commission no disponible:", e);
  }

  // ── 4. La nomina: todo lo que NO cuelga de un prestamo ─────────────────────
  const sinPrestamo = await paginar<Record<string, unknown>>(() => {
    let q = supabase
      .from("pl_transactions")
      .select("check_description,gl_code,gl_name,movement,month,year,loan_number")
      .is("loan_number", null);
    if (month) q = q.eq("month", month);
    if (year) q = q.eq("year", year);
    return q;
  });

  // ── 5. El censo y el emparejamiento ────────────────────────────────────────
  const censo = await cargarCenso();

  /** person_code o, a falta de el, la clave -- para agrupar por persona. */
  const idDe = (p: KnownPerson) => p.personCode ?? `key:${p.keys[0]}`;

  const nominaPorPersona = new Map<string, PayrollRow[]>();
  const nominaFragil = new Map<string, PayrollRow[]>();
  const sinAtribuir: PayrollRow[] = [];

  for (const t of sinPrestamo) {
    const desc = (t.check_description as string) ?? "";
    const parsed = parseDescription(desc);
    if (parsed.shape === "none") continue; // alquiler, publicidad, sucursal
    const m = matchDescription(parsed, censo.people);
    const fila: PayrollRow = {
      check_description: desc,
      gl_code: t.gl_code as string | null,
      gl_name: t.gl_name as string | null,
      month: t.month as string | null,
      year: t.year as number | null,
      amount: Number(t.movement ?? 0),
      shape: parsed.shape,
      method: m.method,
      truncated: parsed.truncated,
    };
    if (!m.person) {
      sinAtribuir.push(fila);
      continue;
    }
    const destino = SHAPES_IN_TOTAL.includes(parsed.shape) ? nominaPorPersona : nominaFragil;
    const id = idDe(m.person);
    destino.set(id, [...(destino.get(id) ?? []), fila]);
  }

  // ── 6. Armar un bloque por loan officer ────────────────────────────────────

  const lineasPorPrestamo = new Map<string, Record<string, unknown>[]>();
  for (const l of loanLines) {
    const ln = (l.loan_number as string)?.trim();
    if (!ln) continue;
    lineasPorPrestamo.set(ln, [...(lineasPorPrestamo.get(ln) ?? []), l]);
  }

  /** Resuelve un nombre de loan_officials contra el censo. */
  const personaDe = (nombre: string) =>
    matchDescription(
      { shape: "comma", key: normalizeName(nombre), personCode: null, truncated: false },
      censo.people,
    ).person;

  const porOficial = new Map<string, Record<string, unknown>[]>();
  for (const o of officials) {
    const n = (o.loan_officer as string)?.trim();
    if (!n) continue;
    porOficial.set(n, [...(porOficial.get(n) ?? []), o]);
  }

  /*
   * Quien cobra en ALGUNA cuenta de compensacion.
   *
   * ⚠ NO SOLO 60105, y mirar solo esa fue un error que costo una cifra entera.
   * La primera medicion del hueco pregunto "¿tiene filas en 60105?" y dio DIEZ
   * personas con 468.184,75 de comision invisible. Era falso: ocho de las diez
   * son branch managers y sales managers que producen, y cobran en SU cuenta.
   * Medido el 2026-09-14:
   *
   *     steve.badovinac   60115 -156.338,45 · 60304 -20.000 · 60303 -5.000
   *     ana.pena          60115 -127.949,06 · 60112 -22.526,61 · 60303 -20.000
   *     julymar.castro    60115 -153.589,32 · 60304 -50.000 · 60112 -25.107,69
   *     armando.tejeda    60112  -27.890,00 · 60115 -13.310,79
   *     mariano.claudio   60117  -34.965,96 · 60303 -16.774,02
   *     c.velasco         60118  -81.040,36
   *     aimmee.buendia    60118   -6.484,14
   *     stephanie.garcia  60112   -6.000,00 · 60115 -2.689,28
   *
   * El hueco de verdad son DOS personas y 17.509,57 -- ver commissionOutsidePayroll.
   */
  const CUENTAS_COMPENSACION = [
    "60105", // Loan Officer Payroll
    "60112", // BM Operating Entity - Salary
    "60115", // BM Operating Entity - Personal Production
    "60117", // Sales Manager payroll
    "60118", // LO Assistant payroll
    "60126", // BM-Regional Entity Payroll
    "60303", // Guarantee
    "60304", // Sign-On Bonus
    "62301", // Vision
    "62304", // Credit From Employee Payroll Deduct
    "62305", // Employee Insurance
    "64100", // Payroll Tax Expense
  ];
  const conNomina = new Set<string>();
  for (const t of sinPrestamo) {
    if (!CUENTAS_COMPENSACION.includes((t.gl_code as string) ?? "")) continue;
    const p = parseDescription((t.check_description as string) ?? "");
    if (p.key) conNomina.add(p.key);
  }

  const officers: OfficerBlock[] = [];
  const usados = new Set<string>();

  for (const [nombre, filas] of porOficial) {
    const persona = personaDe(nombre);
    const id = persona ? idDe(persona) : `lo:${normalizeName(nombre)}`;
    usados.add(id);

    const loans: LoanRow[] = filas.map((f) => {
      const ln = (f.loan_number as string).trim();
      const lineas = lineasPorPrestamo.get(ln) ?? [];
      let margin = 0;
      let other = 0;
      const detail: LoanLine[] = lineas.map((l) => {
        const amt = Number(l.movement ?? 0);
        const esMargen = MARGIN_ALL_GL_LIST.includes((l.gl_code as string) ?? "");
        if (esMargen) margin += amt;
        else other += amt;
        return {
          gl_code: l.gl_code as string | null,
          gl_name: l.gl_name as string | null,
          amount: amt,
          is_margin: esMargen,
        };
      });
      const commission = commissionByLoan.has(ln) ? commissionByLoan.get(ln)! : null;
      return {
        loan_number: ln,
        month: f.month as string | null,
        year: f.year as number | null,
        branch: f.branch as string | null,
        loan_amount: f.loan_amount as number | null,
        margin,
        other,
        commission,
        net: commission == null ? null : margin + other - commission,
        lines: detail,
      };
    });

    const block1Margin = loans.reduce((s, l) => s + l.margin, 0);
    const block1Other = loans.reduce((s, l) => s + l.other, 0);
    const block1Commission = loans.reduce((s, l) => s + (l.commission ?? 0), 0);
    const loansWithoutCommission = loans.filter((l) => l.commission == null).length;

    /*
     * ⚠ LA COMISION NO SE RESTA AQUI, Y ESTO SE MIDIO ANTES DE DECIDIRLO.
     *
     * La comision de Compensafe NO es un pago aparte: es el mismo dinero que
     * sale por la nomina del P&L. Restarla del bloque 1 Y ADEMAS contar 60105 en
     * el bloque 2 la contaria dos veces.
     *
     * Se intento identificar QUE filas son comision, casando por importe exacto
     * dentro de cada persona. No se puede de forma fiable. Medido el 2026-09-14,
     * cuenta por cuenta, en filas que casan / no casan:
     *
     *     60105    28 / 146      60303     0 / 11
     *     60112    16 /  69      60304     0 / 19
     *     60115    17 /  37      60118     0 / 25
     *     60117     4 /   8      64100     0 / 318
     *
     * El solape esta en las cuatro cuentas de sueldo y produccion, no solo en
     * 60105, y no esta en impuestos, seguros ni sign-on bonus. Pero casan 65
     * filas de unas 700 resolubles.
     *
     * Donde casa, el desfase de fecha es limpio --0 dias a fin de mes, 25 a 30 a
     * mitad de mes, porque Compensafe fecha por cierre y el P&L por fecha de
     * pago-- y en un caso es casi perfecto: Steve Badovinac casa 10 de sus 11
     * filas de 60115. Pero los que mas filas tienen fallan ENTEROS:
     * cristhian.ramirez 0 de 23, jorge.zuzunaga 0 de 22, jose.moreyra 0 de 17,
     * jose.zamora 0 de 17. Luis Silva casa 3 de 3 y es el caso bonito, no la
     * regla.
     *
     * ASI QUE MANDA EL P&L, que es donde esta el dinero que salio de verdad:
     * bloque 1 = margen + otros del prestamo, sin tocar la comision. La comision
     * viaja al lado como cifra informativa, con su etiqueta, para poder mirarla
     * sin que entre en la cuenta.
     *
     * Clasificar el 11% y adivinar el resto habria dado un total que resta mal,
     * y eso es peor que dos cifras honestas.
     */
    const block1Net = block1Margin + block1Other;

    const payroll = nominaPorPersona.get(id) ?? [];
    const payrollFragile = nominaFragil.get(id) ?? [];
    const block2Total = payroll.reduce((s, r) => s + r.amount, 0);
    const block2FragileTotal = payrollFragile.reduce((s, r) => s + r.amount, 0);

    const payrollStatus: PayrollStatus =
      payroll.length > 0 ? "located" : payrollFragile.length > 0 ? "fragile_only" : "not_located";

    const claves = persona?.keys ?? [normalizeName(nombre)];
    const cobraEnNomina = claves.some((k) => conNomina.has(k));

    officers.push({
      name: nombre,
      personCode: persona?.personCode ?? null,
      branch: (filas[0]?.branch as string | null) ?? null,
      loans,
      loanCount: loans.length,
      volume: loans.reduce((s, l) => s + (l.loan_amount ?? 0), 0),
      block1Margin,
      block1Other,
      block1Commission,
      loansWithoutCommission,
      block1Net,
      payroll,
      payrollFragile,
      block2Total,
      block2FragileTotal,
      payrollStatus,
      truncatedRows: [...payroll, ...payrollFragile].filter((r) => r.truncated).length,
      // block2Total ya viene con su signo del P&L (los costes son negativos), asi
      // que se SUMA. Restarlo invertiria el signo y daria un neto mejor que el
      // real, que es el unico error que este modulo no puede cometer.
      total: block1Net + block2Total,
      commissionInPayroll: cobraEnNomina,
      commissionOutsidePayroll: block1Commission !== 0 && !cobraEnNomina,
    });
  }

  /*
   * Personas con nomina y SIN un solo cierre.
   *
   * Sin esto Jose Arango no aparece: cuesta 16.836,19 y no esta en
   * loan_officials, asi que un modulo construido solo desde los prestamos no lo
   * enseñaria nunca. Es la mitad inversa del caso de Brian Heibel, y las dos
   * tienen que saltar a la vista.
   */
  for (const [id, filas] of nominaPorPersona) {
    if (usados.has(id)) continue;
    const persona = censo.people.find((p) => idDe(p) === id);
    const fragil = nominaFragil.get(id) ?? [];
    const block2Total = filas.reduce((s, r) => s + r.amount, 0);
    officers.push({
      name: persona?.displayName ?? id,
      personCode: persona?.personCode ?? null,
      branch: null,
      loans: [],
      loanCount: 0,
      volume: 0,
      block1Margin: 0,
      block1Other: 0,
      block1Commission: 0,
      loansWithoutCommission: 0,
      block1Net: 0,
      payroll: filas,
      payrollFragile: fragil,
      block2Total,
      block2FragileTotal: fragil.reduce((s, r) => s + r.amount, 0),
      payrollStatus: "located",
      truncatedRows: [...filas, ...fragil].filter((r) => r.truncated).length,
      total: block2Total,
      commissionInPayroll: true,
      commissionOutsidePayroll: false,
    });
  }

  officers.sort((a, b) => a.total - b.total);

  /*
   * Pares que el origen resuelve a la misma persona y loan_officials tiene
   * separados. Se DERIVA del dato, no de una lista: el dia que haya otro par
   * aparecera solo, sin que nadie tenga que acordarse.
   */
  const collapsedPairs = findCollapsedPairs(
    [...porOficial.keys()].map((name) => ({
      name,
      personCode: personaDe(name)?.personCode ?? null,
    })),
  );

  /*
   * La misma persona partida en dos filas, vista por la forma del resultado y
   * no por la causa. Se calcula sobre `officers` --el resultado ya montado-- a
   * proposito: es lo que el lector tiene delante, y asi lo detecta se haya
   * partido por lo que se haya partido.
   */
  const splitByShape = findSplitByShape(
    officers.map((o) => {
      // Las grafias de la persona, no su nombre mostrado: la mitad con nomina
      // se enseña con el displayName del roster --"july castro"-- y es
      // justamente el que NO comparte extremos con el de loan_officials.
      const persona = o.personCode
        ? censo.people.find((p) => p.personCode === o.personCode)
        : undefined;
      return {
        name: o.name,
        loanCount: o.loanCount,
        payrollLocated: o.payrollStatus === "located",
        keys: persona?.keys ?? [normalizeName(o.name)],
      };
    }),
  );

  /**
   * Comision de gente sin NINGUNA fila de compensacion en el P&L: el hueco real.
   * Medido el 2026-09-14: dos personas, 17.509,57.
   */
  const commissionOutsidePayrollTotal = officers
    .filter((o) => o.commissionOutsidePayroll)
    .reduce((s, o) => s + o.block1Commission, 0);

  const result: LoPnlResult = {
    officers,
    unattributed: {
      rows: sinAtribuir,
      total: sinAtribuir.reduce((s, r) => s + r.amount, 0),
    },
    collapsedPairs,
    splitByShape,
    period: { month, year: year ?? null, all },
    nameKeyAvailable: censo.hasNameKey,
    nameKeyNote: censo.nameKeyNote,
    commissionOutsidePayrollTotal,
  };

  return NextResponse.json(result);
}
