import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { MARGIN_ALL_GL_LIST } from "@/lib/loan-detail-accounts";
import { resolveLoanBranchAlias } from "@/lib/loan-branch";
import { closePeriod } from "@/lib/close-period";
import { getClosedLoans, getPlCoverage, plPeriodLoaded } from "@/lib/loan-source";
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

/**
 * Los dos grupos contables que forman los dos primeros escalones.
 *
 * Literales y no importados de `NON_NET_GROUPS`: esa lista dice lo que el
 * detalle de prestamos DEJA FUERA, y usarla aqui ataria esta escalera a una
 * decision que es de la otra pantalla. Si alli se cambia, aqui no debe moverse
 * solo.
 */
const GRUPO_REVENUE = "Revenue";
const GRUPO_COSTES_DIRECTOS = "Direct Production Costs";

const MESES_NOMBRE = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

/**
 * El nombre, escrito igual venga como venga.
 *
 * ⚠ LAS FUENTES NO SE PONEN DE ACUERDO Y LA PANTALLA LO ENSEÑABA. `july castro`
 * del roster, "LAINO CHEGWIN, GIAN L" del P&L, "Gian Laino" de Salesforce:
 * unos en minuscula, otros en mayuscula, y el lector tenia que deducir que son
 * personas y no codigos.
 *
 * ⚠ SOLO TOCA COMO SE VE, NUNCA COMO SE EMPAREJA. El emparejador trabaja con
 * `normalizeName`, que es otra cosa y vive en lib/lo-payroll-name. Si esto se
 * colara en una clave, dos grafias de la misma persona dejarian de casar.
 *
 * Las particulas se quedan en minuscula --"de", "del", "la", "van"-- porque
 * "Hortencia De Anda" con D mayuscula es un apellido compuesto mal escrito, y
 * ese apellido ya nos costo una regla de emparejamiento.
 */
const PARTICULAS = new Set(["de", "del", "la", "las", "los", "van", "von", "da", "di", "y"]);

function nombreBonito(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  // Un person_code --"jose.arango", "m.rodriguez"-- no es un nombre: se deja
  // como esta en vez de convertirlo en "Jose.arango", que parece un nombre y no
  // lo es.
  if (/^[a-z0-9]+\.[a-z0-9.]+$/i.test(s)) return s;
  return s
    .split(/\s+/)
    .map((p, i) => {
      const bajo = p.toLowerCase();
      if (i > 0 && PARTICULAS.has(bajo)) return bajo;
      // Respeta los guiones: "Tito-Pace", no "Tito-pace".
      return bajo.replace(/(^|[-'])([a-záéíóúñü])/g, (_, sep, c) => sep + c.toUpperCase());
    })
    .join(" ");
}

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

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * UN APUNTE DEL P&L, SIN AGRUPAR
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ SE DEVUELVEN LAS FILAS CRUDAS Y NO UNA SUMA POR CUENTA, y la razon esta
 * medida: agrupar por `gl_code` + `branch` esconderia 590.857,86 de movimiento
 * en 727 grupos, y en 317 de ellos --209 prestamos-- lo que se tapa son filas
 * que se compensan entre si.
 *
 * El prestamo 710002042266 lo enseña entero. Agrupado salen doce lineas;
 * crudas son catorce, y las dos que desaparecen son justo las interesantes:
 *
 *     41205  Other HUD Fees, Net  710   +389,00  "710002042266|PEREZ | UBALDO"
 *     41205  Other HUD Fees, Net  710   -333,00  "ADMIN FEE ON FILE ..."
 *       agrupadas: +56,00
 *
 *     41309  DM Margin            700   +448,50
 *     41309  DM Margin            700   -280,31
 *       agrupadas: +168,19
 *
 * Es el MISMO fenomeno que hace visible el par 41305 LO Margin / 41200 Discount
 * Income --opuestos exactos de 9.602,39-- solo que dentro de una sola cuenta.
 * Una vista que existe para no colapsar no puede colapsar por su cuenta.
 */
export interface LoanLine {
  gl_code: string | null;
  gl_name: string | null;
  /** El grupo contable, tal cual. No se reagrupa nada por el: se enseña. */
  category_7: string | null;
  /**
   * El grupo contable, que es lo que reparte cada linea en su escalon.
   *
   * ⚠ AQUI VIVIA UNA DISCREPANCIA CON EL DETALLE DE PRESTAMOS, YA RESUELTA.
   * Aquella pantalla contaba solo `category_6 = "Revenue"` y esta contaba todas
   * las lineas, asi que el mismo prestamo daba dos cifras. Desde el 2026-09-15
   * `NET_GROUPS` lleva tambien "Direct Production Costs" y las dos coinciden.
   * Se deja escrito el calculo porque es el que justifica el cambio, y porque
   * el dia que alguien toque NET_GROUPS tiene que saber que hay otra pantalla
   * al otro lado. Sobre 710002042266:
   *
   *     Revenue                  7.986,43   11 filas   41200 41205 41215
   *                                                    41305 41306 41309
   *                                                    41830 55275
   *     Direct Production Costs    416,70    3 filas   55265 Condo Fees
   *                                                    55550 Appraisal
   *                                                    55600 Credit Report
   *     TOTAL                    8.403,13   14 filas
   *
   * ─── POR QUE SE DECIDIO ASI, Y NO AL REVES ─────────────────────────────────
   *
   * Sobre los 482 cierres de la division con apuntes:
   *
   *     solo Revenue        5.577.387,15
   *     todas las lineas    5.625.016,96
   *     diferencia             47.629,81   =  0,85%
   *
   * ⚠ PERO LA MEDIA POR PRESTAMO ES 17,03% Y LA MEDIANA 1,59%, y esa distancia
   * ES el hallazgo: no es una diferencia repartida, es una cola. Mediana 1,59%,
   * p95 9,09%, y luego 22 prestamos por encima del 10%, seis del 25%, cinco del
   * 50% y DOS por encima del 100% --donde lo excluido supera al Revenue--.
   *
   * ⚠ Y LA COLA ES UNA SOLA CUENTA, NO EL COSTE ORDINARIO DEL PRESTAMO:
   *
   *     55601  One-Time Transfers    32 lineas   16 prestamos   bruto 334.352,38
   *
   * Es la que produce los dos casos del 100%: el 203001997314 lleva +12.450,00
   * contra 208,00 de Revenue, y el 707002013216 lleva -32.144,00 en mayo contra
   * un BM Margin de marzo. Quitandola, la diferencia agregada sube a 1,43% --sube
   * porque su neto es negativo-- y el resto es coste de prestamo de toda la vida:
   * Credit Report en 345 prestamos, U/W - TALX en 193, tasacion en 22.
   *
   * ⚠ SG&A Y PERSONAL NO MUEVEN NADA HOY, PERO SE VERAN. 70100 Marketing son 270
   * lineas en 100 prestamos con neto EXACTAMENTE 0,00, y 60125 Operations Payroll
   * otras 24 en 12, tambien 0,00: son pares que se anulan dentro de cada
   * prestamo. Un solo prestamo tiene SG&A con neto distinto de cero --el
   * 700002013844, con -8.721,60 de Office Expense--. Asi que incluirlos no cambia
   * ningun total, pero SI hace aparecer 270 lineas de marketing en el desglose.
   *
   * Lo que si se hace es DECIRLO: el pie del desglose reparte el total por
   * grupo, para que las dos cifras se vean una al lado de la otra en vez de
   * descubrirse por sorpresa comparando dos pantallas.
   */
  category_6: string | null;
  /**
   * La sucursal DEL APUNTE, que no siempre es la del prestamo.
   *
   * Parte del margen se contabiliza en la 700 --el DM Margin de este ejemplo--
   * y eso es informacion, no ruido: sin ella, dos lineas de la misma cuenta
   * 41205 en sucursales distintas parecen un duplicado.
   */
  branch: string | null;
  /**
   * La linea esta contabilizada en la sucursal del prestamo, asi que SUMA en
   * la escalera. Cuando es false la linea se enseña igual, bajo "Booked
   * elsewhere", pero no entra en ningun escalon.
   *
   * ⚠ SE COMPARA CONTRA EL ALIAS, NO CONTRA EL TEXTO CRUDO. "Affinity" es la
   * 716 en el P&L, y sin resolverlo 39 prestamos saldrian con cero propio y
   * 326.433,66 desaparecerian sin motivo. Medido: 52 prestamos sin nada propio
   * antes de resolver el alias, 13 despues.
   */
  in_branch: boolean;
  /** El periodo del apunte. No tiene por que ser el del cierre. */
  month: string | null;
  year: number | null;
  /**
   * La descripcion, que es lo unico que distingue dos filas de la misma cuenta
   * y la misma sucursal. Sin ella el par de 41205 se lee como un error de
   * carga en vez de como un cobro y su ajuste.
   */
  check_description: string | null;
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

  /*
   * ─── LA ESCALERA ──────────────────────────────────────────────────────────
   *
   * Los escalones en que se lee el resultado de un prestamo, en orden:
   *
   *     Branch gross revenue      lo que dejo, ANTES de pagar al loan officer
   *   ± Direct production costs   tasacion, informe de credito, verificacion
   *   ± Other booked to the loan  lo que no es ninguno de los dos
   *   - LO commission             lo que cobra el loan officer
   *   = Total contribution
   *
   * Medido sobre 710002042266: 7.986,43 + 416,70 + 0 - 5.045,63 = 3.357,50.
   *
   * ⚠ LOS COSTES DIRECTOS SUMAN, NO RESTAN, y su etiqueta no puede decir
   * "menos". Salen en POSITIVO --+416,70 en este prestamo-- porque se le cobran
   * al prestatario y vuelven a la sucursal. Una etiqueta que dijera "− Direct
   * production costs" con un numero positivo al lado diria literalmente lo
   * contrario de lo que pasa. El signo se enseña tal cual viene.
   *
   * ⚠ `grossRevenue + directCosts + otherBooked` ES EXACTAMENTE `margin +
   * other`. La escalera DESCOMPONE lo que ya se contaba; no añade ni quita una
   * sola linea, y por eso `produced`, `block1Net` y el neto de cada persona no
   * se mueven ni un centimo al introducirla.
   */

  /**
   * `category_6 = 'Revenue'` CONTABILIZADO EN LA SUCURSAL DEL PRESTAMO.
   *
   * ⚠ NO ES TODO EL REVENUE DEL PRESTAMO, y la diferencia es grande: en la
   * division, 5.633.738,56 de revenue y costes directos contra 4.410.393,46
   * que se queda su propia sucursal. Un 22% se contabiliza en otro sitio --casi
   * todo en la 700, que es el margen de division--.
   *
   * Lo que se va NO se esconde: viaja en `bookedElsewhere` y el desglose lo
   * lista con su subtotal. Es revenue real del prestamo; simplemente no se lo
   * queda esa sucursal.
   */
  grossRevenue: number;
  /** `category_6 = 'Direct Production Costs'` en su sucursal. Con su signo. */
  directCosts: number;
  /**
   * Lo que no cae en ninguno de los dos grupos anteriores. Casi siempre cero.
   *
   * ⚠ EXISTE PARA NO TIRAR NADA. Son SG&A y Personnel: 70100 Marketing con 270
   * lineas en 100 prestamos y neto EXACTAMENTE 0,00, y 60125 Operations Payroll
   * con 24 en 12, tambien 0,00 -- pares que se anulan dentro del prestamo. Un
   * solo prestamo tiene neto distinto de cero aqui, el 700002013844 con
   * -8.721,60 de Office Expense.
   *
   * Un escalon de mas que casi siempre vale cero es barato; una linea que
   * desaparece de la escalera sin que nadie lo note, no. Solo se enseña cuando
   * no es cero.
   */
  otherBooked: number;
  /**
   * Todo lo del prestamo contabilizado FUERA de su sucursal. No entra en ningun
   * escalon ni en la contribucion.
   *
   * ⚠ SE DEVUELVE PARA QUE SE VEA, no para sumarlo. Sin este numero el lector
   * ve una escalera que no cuadra con lo que sabe del prestamo y no tiene forma
   * de saber cuanto se fue ni adonde.
   */
  bookedElsewhere: number;
  /**
   * La sucursal de este prestamo NO TIENE NI UNA LINEA en todo el P&L.
   *
   * ⚠ NO ES LO MISMO QUE "no gano nada aqui", y sin distinguirlo la pantalla
   * las enseña igual. La 776 y la 150 no existen en `pl_transactions`: sus
   * nueve cierres no pueden tener gross revenue propio por construccion, y su
   * revenue esta contabilizado en la 700 y la 733.
   *
   * Es la misma situacion que el alias de Affinity arregla, y a estas dos NO se
   * les pone alias porque su revenue se reparte entre dos sucursales -- elegir
   * una seria mover dinero por una corazonada. Ver lib/loan-branch.ts.
   */
  branchNotInPl: boolean;
  /**
   * Lo que se le pago al loan officer por ESTE prestamo, de comp.loan_commission.
   * Null cuando el prestamo no cruza, que NO es cero.
   */
  commission: number | null;
  /**
   * El ultimo escalon: lo que el prestamo dejo a la sucursal DESPUES de pagar
   * al loan officer.
   *
   * Null cuando la comision no se conoce: un prestamo que no cruza con
   * Compensafe no tiene contribucion calculable, y poner aqui el bruto diria
   * que no se le pago a nadie.
   */
  contribution: number | null;
  /** margin + other - commission. Identico a `contribution`. */
  net: number | null;
  /**
   * Su mes de cierre no tiene P&L cargado todavia.
   *
   * ⚠ ESO NO ES "NO TIENE P&L": ES P&L PARCIAL, y la distincion es la que
   * decide como se trata. El coste de originacion se contabiliza al ABRIR el
   * expediente y el margen al CERRAR el mes, asi que un cierre de agosto ya
   * puede llevar semanas con coste apuntado en julio mientras su ingreso no ha
   * llegado.
   *
   * Medido el 2026-09-15 sobre los 61 cierres de agosto y septiembre: CATORCE
   * ya tienen filas, todas de julio y todas coste -- U/W - TALX 1.984,49 en doce
   * prestamos y Loan Setup 375,00 en tres, 2.359,49 en total, repartido entre
   * diez loan officers.
   *
   * Por eso NO se excluyen enteros del bloque 1: eso borraria un coste real que
   * ya ocurrio. Y por eso tampoco se dejan dentro del neto: mostrarian coste sin
   * su ingreso, que se lee como perdida de alguien que todavia no ha cobrado.
   * Van aparte, con su coste a la vista.
   */
  plPending: boolean;
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

/**
 * A que pregunta pertenece esta persona.
 *
 * ⚠ LA PANTALLA MEZCLABA LOS CUATRO Y POR ESO NO SE ENTENDIA. Un procesador con
 * coste y cero cierres salia igual que un loan officer que no cerro nada, y lo
 * primero es su trabajo mientras lo segundo es un hallazgo.
 *
 * ⚠ EL EJE ES `is_producer`, NO EL TEXTO DEL CARGO. En `org.roster_current` hay
 * 42 cargos distintos para 114 personas, con mayusculas mezcladas y variantes
 * del mismo puesto --"LO ASSISTANT" y "LOAN OFFICER ASSISTANT", "BUSINESS
 * DEVELOPER" y "BUSINESS DEVELOPMENT"--. Agrupar por ese texto inventaria
 * categorias. El booleano ya lo resolvio alguien aguas arriba.
 *
 * ⚠ Y EL NOMBRE DEL CARGO PUEDE CONTRADECIRLO: los dos "NonProducing Branch
 * Manager" tienen `is_producer = true`. Manda el booleano; el cargo se enseña
 * tal cual para que quien lo lea vea la contradiccion en vez de sospechar del
 * dato.
 */
export type OfficerGroup =
  /** Cierra prestamos. "¿Se paga solo?" tiene sentido pleno aqui. 36 personas. */
  | "producer"
  /** NPPM: otra figura y otra pregunta. 6. */
  | "nppm"
  /** Asistentes, procesadores, soporte. Coste real y cero cierres: 62. */
  | "support"
  /**
   * No esta en `roster_current`, asi que no hay cargo que mostrar. 22 personas.
   *
   * Son las bajas --Vermejo, Anderson-- y quienes nunca estuvieron en RRHH. NO
   * se meten en otro cubo: "cargo no disponible" es lo honesto.
   *
   * ⚠ OBSERVACION, NO AFIRMACION: los NUEVE loan officers sin nomina localizada
   * caen TODOS aqui, ninguno en `producer`. Y encaja con otra cosa medida --los
   * prefijos de prestamo 913, 203 y 150, que no existen en el catalogo de
   * sucursales y se agrupan por persona-- apuntando a que produzcan sin ser de
   * la division. Es una correlacion sobre 22 personas, no una conclusion, y no
   * se resuelve desde esta pantalla.
   */
  | "unknown";

export interface OfficerBlock {
  name: string;
  personCode: string | null;
  branch: string | null;
  /** El cargo tal cual viene del roster. Null cuando no esta. */
  position: string | null;
  area: string | null;
  group: OfficerGroup;

  // ── Bloque 1 ──
  loans: LoanRow[];
  loanCount: number;
  volume: number;
  block1Margin: number;
  block1Other: number;

  /*
   * ── LA ESCALERA DE LA PERSONA: LA SUMA DE LA DE SUS PRESTAMOS ─────────────
   *
   *     block1Revenue + block1DirectCosts + block1OtherBooked = block1Net
   *     block1Net - block1Commission                          = contribution
   *
   * ⚠ Y `contribution` NO SE PUEDE ENCADENAR CON LA NOMINA. Es la trampa de
   * este modulo y esta medida: la comision se PAGA POR LA NOMINA, asi que
   * restarla aqui y ademas restar `block2Total` entero resta el mismo dinero
   * dos veces. En la division son 1.163.656,81 de comision dentro de una
   * nomina de 5.362.891,98 -- el 21,7% del coste, contado otra vez.
   *
   * Por eso la pantalla enseña DOS finales y no uno encadenado:
   *
   *     contribution   ¿que dejo cada PRESTAMO despues de pagar al LO?
   *     total          ¿se paga sola esta PERSONA?  = block1Net + block2Total
   *
   * Son dos preguntas distintas sobre los mismos datos, y la respuesta a una no
   * es un paso intermedio de la otra.
   */

  /** `category_6 = 'Revenue'` de sus cierres evaluables. */
  block1Revenue: number;
  /** `category_6 = 'Direct Production Costs'`. Con su signo: suele SUMAR. */
  block1DirectCosts: number;
  /** Lo que no es ninguno de los dos. Casi siempre cero; ver LoanRow. */
  block1OtherBooked: number;
  /**
   * Lo de sus prestamos contabilizado FUERA de la sucursal de cada prestamo.
   *
   * ⚠ NO ENTRA EN NINGUN TOTAL. Se devuelve para poder decir cuanto revenue del
   * prestamo no se queda la sucursal -- 1.280.161,00 en la division, el 22,8%,
   * casi todo margen de division en la 700. Sin esta cifra la escalera parece
   * que pierde dinero por el camino.
   */
  block1Elsewhere: number;
  /**
   * Cierres suyos cuya sucursal no existe en el P&L. Ver LoanRow.branchNotInPl.
   *
   * Se cuenta por persona porque es donde se lee: siete de los nueve son de
   * Silvio Arteaga, y sin el contador su fila parece la de alguien que no
   * produce.
   */
  loansBranchNotInPl: number;
  /** block1Net - block1Commission. El ultimo escalon, a nivel de persona. */
  contribution: number;

  /** Suma de las comisiones conocidas. */
  block1Commission: number;
  /** Prestamos cuya comision no cruzo. Se dice; no se cuenta como cero. */
  loansWithoutCommission: number;
  /**
   * Cierres cuyo mes no tiene P&L cargado. FUERA de block1Net y del total.
   *
   * ⚠ EL CONTADOR TIENE QUE DECIR LAS DOS COSAS, no solo cuantos son:
   * "2 closings pending P&L - 593 already booked, margin not yet loaded".
   * Uno que solo diga "2 pendientes" esconde que ya hay coste real apuntado, y
   * entonces el lector supone que no hay nada y se lleva una sorpresa cuando
   * cargue el mes.
   */
  loansPendingPl: number;
  /**
   * Coste de originacion YA contabilizado de esos cierres. Negativo.
   *
   * No es cero casi nunca: U/W - TALX y Loan Setup se apuntan al abrir el
   * expediente. Medido el 2026-09-15: 2.359,49 entre diez loan officers.
   */
  pendingPlBooked: number;
  block1Net: number;

  /*
   * ── LA CUENTA, EN EL ORDEN EN QUE SE LEE ──────────────────────────────────
   *
   * La tabla tenia tres columnas de dinero y ninguna decia de donde salia la
   * siguiente: Gian Laino producia 22.469, costaba 16.919, y el neto ponia
   * 5.551 sin que se viera la resta. Estas cuatro se leen de izquierda a
   * derecha como una cuenta y CADA UNA SE RECONSTRUYE DE LAS DE AL LADO:
   *
   *     produced - commission - otherCost = net
   *
   * Gian Laino, medido: 237.219,98 - 76.070,71 - 49.570,87 = 111.578,40.
   *
   * ⚠ ES LA MISMA CIFRA QUE `total`, no una segunda. La igualdad se cumple
   * siempre porque otherCost se define como "la nomina que no es comision", asi
   * que produced - comision - (nomina - comision) = produced - nomina. Sacar el
   * desglose NO cambia ningun total: lo hace legible.
   *
   * ⚠ Y HACE VISIBLE LO QUE ESTABA ENTERRADO EN UN COMENTARIO: la comision sale
   * POR la nomina, no encima. Restarla y ademas contar 60105 la contaria dos
   * veces, y por eso `total` nunca la resto -- pero nadie podia verlo.
   */

  /** Lo que dejaron sus prestamos. Igual a block1Net. */
  produced: number;
  /** Lo que cobro por cerrarlos, de Compensafe. Positivo. */
  commission: number;
  /**
   * El resto de su nomina: nomina localizada menos comision. Positivo.
   *
   * ⚠ PUEDE SALIR NEGATIVO, y cuando pasa NO se pinta: se marca. Ver
   * `commissionExceedsPayroll`.
   */
  otherCost: number;
  /** produced - commission - otherCost. Identico a `total`. */
  net: number;
  /**
   * La comision es MAYOR que la nomina localizada, asi que `otherCost` sale
   * negativo -- lo que leido literalmente diria que sus otros costes le
   * devolvieron dinero.
   *
   * ⚠ ES UN DETECTOR QUE LA MARCA ANTERIOR NO TENIA. `commissionOutsidePayroll`
   * pregunta "¿tiene ALGUNA nomina?"; esta pregunta "¿le CABE la comision
   * dentro?". Medido el 2026-09-15: salta en CUATRO personas y solo tres
   * llevaban la marca vieja. La cuarta es Haydee Tito-Pace, con nomina
   * localizada de 1.292 contra 32.179 de comision -- veinticinco veces mas --
   * y nadie lo estaba viendo.
   *
   * ⚠ DICE LO QUE SE VE Y NO DIAGNOSTICA. Las causas son varias y la pantalla
   * no las distingue: P&L del periodo sin cargar --el caso de Haydee, sucursal
   * 728--, nomina sin atribuir, o comision mal cruzada. Afirmar cual seria
   * inventar.
   */
  commissionExceedsPayroll: boolean;

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
  /*
   * ⚠ LA SUCURSAL SE HEREDA DEL MODAL; EL MES, NO.
   *
   * Cuando esta vista vive dentro del P&L de una sucursal, la sucursal la
   * impone el modal. El mes NO, y es deliberado: la pregunta del modal es "que
   * paso en este mes" y la de aqui es "cuanto produce y cuanto cuesta esta
   * persona", que solo tiene sentido a lo largo del tiempo.
   *
   * Medido: Sergio Vermejo cerro UNA VEZ en noviembre de 2025 y siguio costando
   * hasta mayo de 2026. En cualquier vista mensual posterior desaparece, y con
   * el el unico caso que enseña por que este modulo existe.
   */
  const branches = searchParams.getAll("branch").filter(Boolean);

  const all = searchParams.get("all") === "1";
  const def = closePeriod();
  const month = all ? null : searchParams.get("month") ?? def.month;
  const year = all ? null : Number(searchParams.get("year") ?? def.year);

  /*
   * ── 1. Los prestamos del periodo, del espejo ──────────────────────────────
   *
   * Deja de leerse `finance_division.loan_officials`. Ese archivo se sube a
   * mano y llevaba tres semanas parado: 436 prestamos contra 494 cierres en el
   * espejo. Para ESTE modulo la diferencia no era cosmetica -- Compensafe habia
   * pagado comision por 54 prestamos que el archivo no tenia, 125.521,22, asi
   * que el bloque 1 estaba corto en volumen, margen Y comision a la vez, sin
   * ningun sintoma. Un loan officer podia parecer que no se paga solo
   * simplemente porque no se veian sus cierres.
   *
   * ⚠ SE ADAPTA EN EL BORDE: la fila conserva las mismas claves, asi que nada
   * de lo que sigue cambia. El filtro de "que cuenta" --is_closed AND
   * counts_for_division-- vive en lib/loan-source y no se reescribe aqui.
   */
  const [cerrados, plCoverage, rosterRows] = await Promise.all([
    /*
     * ⚠ EL FILTRO DE SUCURSAL ACOTA LOS CIERRES, NO LA NOMINA. La nomina de una
     * persona no tiene sucursal de produccion: sale de las cuentas de
     * compensacion, que se contabilizan donde se contabilizan. Filtrarla
     * tambien dejaria a la gente de la sucursal con sus cierres y sin su coste,
     * que es justo el numero que el modulo existe para enseñar.
     *
     * Asi que dentro de una sucursal se lee: "estos son SUS loan officers, con
     * lo que produjeron aqui y lo que cuestan en total".
     */
    getClosedLoans({ month, year, branches: branches.length ? branches : null }),
    getPlCoverage(),
    /*
     * El cargo de cada persona. Que falle NO puede tumbar la pantalla: sin
     * roster todo el mundo cae en "unknown", que es peor pero es honesto.
     */
    createServerClient("org")
      .from("roster_current")
      .select("person_code,position,area,is_producer,is_nppm_realtor")
      .range(0, 999)
      .then((r) => (r.data ?? []) as Array<Record<string, unknown>>)
      .then((d) => d, () => [] as Array<Record<string, unknown>>),
  ]);

  const roster = new Map(rosterRows.map((r) => [r.person_code as string, r]));

  /** Cargo y grupo de una persona. Sin roster, "unknown" y sin cargo. */
  const cargoDe = (code: string | null): { position: string | null; area: string | null; group: OfficerGroup } => {
    const r = code ? roster.get(code) : undefined;
    if (!r) return { position: null, area: null, group: "unknown" };
    return {
      position: (r.position as string) ?? null,
      area: (r.area as string) ?? null,
      // ⚠ El booleano manda sobre el texto del cargo: los dos "NonProducing
      // Branch Manager" tienen is_producer = true.
      group: r.is_producer ? "producer" : r.is_nppm_realtor ? "nppm" : "support",
    };
  };

  /*
   * El mes real de cierre de cada prestamo, que NO es el `month` de la consulta:
   * con `all=1` ese viene null, y hace falta para saber si su P&L esta cargado.
   */
  const cierreMes = new Map<string, string | null>();
  const cierreAnio = new Map<string, number | null>();
  for (const l of cerrados) {
    const [y, m] = (l.closingMonth ?? "").split("-");
    cierreMes.set(l.loanNumber, m ? MESES_NOMBRE[Number(m) - 1] ?? null : null);
    cierreAnio.set(l.loanNumber, Number(y) || null);
  }

  const officials = cerrados.map((l) => ({
    loan_number: l.loanNumber,
    loan_officer: l.loanOfficer,
    branch: l.branch,
    loan_amount: l.loanAmount,
    month: cierreMes.get(l.loanNumber) ?? null,
    year: cierreAnio.get(l.loanNumber) ?? null,
  }));

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
          .select("loan_number,gl_code,gl_name,category_7,category_6,branch,month,year,check_description,movement")
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
   * ─────────────────────────────────────────────────────────────────────────
   * ¿EXISTE ESTA SUCURSAL EN LA CONTABILIDAD?
   * ─────────────────────────────────────────────────────────────────────────
   *
   * ⚠ LA DIFERENCIA ENTRE "NO GANO NADA AQUI" Y "AQUI NO HAY CONTABILIDAD" ES
   * TODA LA DIFERENCIA, y sin esta comprobacion la pantalla las enseña igual.
   *
   * Medido el 2026-09-15: `pl_transactions` no tiene NI UNA linea en la 776 ni
   * en la 150. Sus nueve cierres --siete de Silvio Arteaga, dos de Anthony
   * DiToma-- salen con gross revenue cero, y leido sin mas parece que esos
   * prestamos no dejaron nada. Lo que pasa es que su sucursal no existe en el
   * libro: su revenue esta en la 700 y la 733.
   *
   * Se pregunta SOLO por las sucursales que tienen algun prestamo sin nada
   * propio --dos o tres-- y con `head: true`, asi que no trae filas.
   */
  const sucursalesSinContabilidad = new Set<string>();
  {
    const sospechosas = new Set<string>();
    for (const [, filas] of porOficial) {
      for (const f of filas) {
        const suc = resolveLoanBranchAlias(f.branch as string | null);
        if (!suc) continue;
        const suyas = lineasPorPrestamo.get((f.loan_number as string).trim()) ?? [];
        if (suyas.length > 0 && !suyas.some((l) => l.branch === suc)) sospechosas.add(suc);
      }
    }
    for (const suc of sospechosas) {
      const { count } = await supabase
        .from("pl_transactions")
        .select("*", { count: "exact", head: true })
        .eq("branch", suc);
      if ((count ?? 0) === 0) sucursalesSinContabilidad.add(suc);
    }
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
      /*
       * ⚠ EL ALIAS SE RESUELVE ANTES DE COMPARAR, Y NO ES UN DETALLE.
       *
       * `resolveLoanBranchAlias` --Regla 1 sola-- convierte "Affinity" en 716,
       * que es donde el P&L contabiliza sus prestamos. Sin resolverlo, los 40
       * cierres de Affinity saldrian con cero propio y 326.433,66 se irian
       * enteros a "booked elsewhere" sin ningun motivo real. Medido: 52
       * prestamos sin nada en su sucursal antes de resolver el alias, 13
       * despues.
       *
       * ⚠ REGLA 1, NO `normalizeLoanBranch`. Esa aplica ademas la Regla 2 y
       * devuelve null para lo que no empieza por 7 -- las sucursales 150 y 276,
       * que tienen tres cierres de la division. Con ella, esos tres verian TODO
       * su revenue como "de otra sucursal" por una regla de alcance contable
       * que aqui no se esta preguntando.
       */
      const sucursalPrestamo = resolveLoanBranchAlias(f.branch as string | null);

      let margin = 0;
      let other = 0;
      // Los escalones. Se acumulan en la MISMA pasada que margin/other para que
      // no puedan separarse: son dos lecturas de las mismas lineas, y calcularlas
      // en sitios distintos es como se llega a que dejen de cuadrar.
      let grossRevenue = 0;
      let directCosts = 0;
      let otherBooked = 0;
      let bookedElsewhere = 0;
      const detail: LoanLine[] = lineas.map((l) => {
        const amt = Number(l.movement ?? 0);
        const esMargen = MARGIN_ALL_GL_LIST.includes((l.gl_code as string) ?? "");
        if (esMargen) margin += amt;
        else other += amt;

        const enSuSucursal =
          sucursalPrestamo !== null && (l.branch as string | null) === sucursalPrestamo;
        if (!enSuSucursal) {
          bookedElsewhere += amt;
        } else {
          const grupo = (l.category_6 as string | null) ?? null;
          if (grupo === GRUPO_REVENUE) grossRevenue += amt;
          else if (grupo === GRUPO_COSTES_DIRECTOS) directCosts += amt;
          else otherBooked += amt;
        }
        return {
          in_branch: enSuSucursal,
          gl_code: l.gl_code as string | null,
          gl_name: l.gl_name as string | null,
          category_7: l.category_7 as string | null,
          category_6: l.category_6 as string | null,
          branch: l.branch as string | null,
          month: l.month as string | null,
          year: l.year as number | null,
          check_description: l.check_description as string | null,
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
        grossRevenue,
        directCosts,
        otherBooked,
        bookedElsewhere,
        branchNotInPl: sucursalPrestamo !== null && sucursalesSinContabilidad.has(sucursalPrestamo),
        commission,
        contribution: commission == null ? null : grossRevenue + directCosts + otherBooked - commission,
        // `net` ya no es identico a `contribution`: usa TODAS las lineas, esten
        // donde esten, mientras la contribucion solo cuenta las de su sucursal.
        net: commission == null ? null : margin + other - commission,
        // Su mes de cierre no tiene P&L. Puede tener coste apuntado igual: ver
        // la nota en LoanRow.plPending.
        plPending: !plPeriodLoaded(plCoverage, cierreMes.get(ln) ?? null, cierreAnio.get(ln) ?? null),
        lines: detail,
      };
    });

    /*
     * ⚠ LOS CIERRES CUYO MES NO TIENE P&L NO ENTRAN EN EL BLOQUE 1, y esto no
     * es lo mismo que decir que no tienen P&L.
     *
     * El coste de originacion --U/W - TALX, Loan Setup-- se contabiliza al
     * ABRIR el expediente; el margen, al cerrar el mes. Asi que un cierre de
     * agosto puede llevar ya un coste apuntado en julio mientras su ingreso
     * todavia no ha llegado. Medido el 2026-09-15: de los 61 cierres de agosto y
     * septiembre, CATORCE ya tienen filas --2.359,49 de coste, entre diez loan
     * officers-- y los otros 47 ninguna.
     *
     * Las dos salidas obvias mienten, cada una en un sentido:
     *
     *   excluirlos enteros   borra 2.359,49 de coste que SI ocurrio
     *   dejarlos en el neto  enseña coste sin su ingreso, y eso se lee como
     *                        que esa persona pierde dinero
     *
     * Por eso van APARTE: fuera del neto, con su conteo y con su coste ya
     * contabilizado a la vista. No se borra nada y no se mezcla nada.
     *
     * ⚠ SUS CIERRES Y SU VOLUMEN SI CUENTAN. El prestamo se cerro y su importe
     * es real; lo unico que falta es el margen. Sacarlos tambien de loanCount
     * diria que esa persona cerro menos de lo que cerro.
     */
    const evaluables = loans.filter((l) => !l.plPending);
    const pendientes = loans.filter((l) => l.plPending);

    const block1Margin = evaluables.reduce((s, l) => s + l.margin, 0);
    const block1Other = evaluables.reduce((s, l) => s + l.other, 0);
    const block1Commission = evaluables.reduce((s, l) => s + (l.commission ?? 0), 0);
    const loansWithoutCommission = evaluables.filter((l) => l.commission == null).length;

    // Los escalones de la persona: la suma de los de sus prestamos.
    const block1Revenue = evaluables.reduce((s, l) => s + l.grossRevenue, 0);
    const block1DirectCosts = evaluables.reduce((s, l) => s + l.directCosts, 0);
    const block1OtherBooked = evaluables.reduce((s, l) => s + l.otherBooked, 0);

    /** Coste ya apuntado de los pendientes. Negativo, y no entra en el total. */
    // Su propia sucursal, igual que el bloque 1: si contara todas las lineas,
    // el coste pendiente y el neto se medirian con dos varas distintas.
    const pendingPlBooked = pendientes.reduce(
      (s, l) => s + l.grossRevenue + l.directCosts + l.otherBooked, 0);

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
    /*
     * ⚠ EL BLOQUE 1 ES AHORA SOLO LO DE SU PROPIA SUCURSAL, y esto mueve el
     * neto de TODO EL MUNDO. Era `block1Margin + block1Other`, o sea todas las
     * lineas del prestamo estuvieran donde estuvieran.
     *
     * Medido sobre los 494 cierres de la division:
     *
     *     todas las lineas          5.625.016,96
     *     solo su propia sucursal   4.344.855,96
     *     contabilizado fuera       1.280.161,00   (el 22,8%)
     *
     * En Gian Laino, produced pasa de 274.719,19 a 194.780,97.
     *
     * La razon es que la pregunta es "¿que se queda ESTA sucursal?", y el
     * margen de division que se contabiliza en la 700 no se lo queda. Lo que
     * se va no se borra: `block1Elsewhere` lo lleva y la pantalla lo enseña.
     */
    const block1Elsewhere = evaluables.reduce((s, l) => s + l.bookedElsewhere, 0);
    const block1Net = block1Revenue + block1DirectCosts + block1OtherBooked;

    const payroll = nominaPorPersona.get(id) ?? [];
    const payrollFragile = nominaFragil.get(id) ?? [];
    const block2Total = payroll.reduce((s, r) => s + r.amount, 0);
    const block2FragileTotal = payrollFragile.reduce((s, r) => s + r.amount, 0);

    const payrollStatus: PayrollStatus =
      payroll.length > 0 ? "located" : payrollFragile.length > 0 ? "fragile_only" : "not_located";

    /*
     * ─────────────────────────────────────────────────────────────────────────
     * ⚠ SI NECESITAS SABER SI ALGUIEN TIENE NOMINA, PREGUNTASELO A
     *   `payrollStatus`. CUALQUIER OTRO CAMINO VA A FALLAR DONDE EL
     *   EMPAREJADOR ACIERTA.
     * ─────────────────────────────────────────────────────────────────────────
     *
     * Esta linea ha estado mal DOS VECES, y las dos por el mismo motivo: un
     * atajo escrito al lado de la logica buena, que no sabe lo que ella sabe.
     *
     *   1ª. "¿tiene filas en 60105?" -- dio DIEZ personas con 468.184,75 de
     *       comision invisible. Falso: ocho eran branch managers y sales
     *       managers que cobran en SU cuenta (60112, 60115, 60117, 60118,
     *       60126, 60303, 60304, 62301, 62304, 62305, 64100). Se arreglo
     *       ampliando a las doce cuentas.
     *
     *   2ª. Un `Set` con las claves crudas de esas doce cuentas, y
     *       `conNomina.has(k)`. Eso es igualdad exacta: sin `contained`, sin
     *       `ends`, sin censo. Medido el 2026-09-14, marcaba a NUEVE personas
     *       declarando 139.415 de comision sin nomina, y SEIS eran falsas --
     *       136.419 de esos 139.415, el 98%.
     *
     *       Gian Laino cobra como "LAINO CHEGWIN, GIAN L", clave
     *       "gian laino chegwin", que no esta literal entre sus claves del
     *       censo. El Set decia que no cobraba. Tiene 177 filas de nomina y
     *       -125.642. El emparejador lo resuelve por `contained` sin dudar.
     *
     * Por eso ahora se DERIVA de `payrollStatus`, que sale del mismo
     * emparejador que decide todo lo demas. No hay una segunda respuesta a esta
     * pregunta, y no debe haberla: el arreglo lo puede deshacer el proximo que
     * necesite la respuesta rapido y escriba otro atajo.
     *
     * ⚠ `fragile_only` CUENTA COMO SIN NOMINA, y es deliberado. Susan Aguilar
     * (3 filas, 126,00) y Silvio Arteaga (2 filas, 252,00) SI tienen filas,
     * pero por formas de descripcion fragiles que quedan FUERA del total. La
     * marca no dice "no la encontramos" sino "no esta contada", que es lo que
     * hace verdadera la advertencia: su coste en el total esta subestimado
     * igual que el de quien no tiene ninguna.
     *
     * ⚠ NO ES EXACTAMENTE LO MISMO QUE "cobra en una cuenta de compensacion",
     * y se midio antes de cambiarlo. El bloque 2 cuenta lo que cuesta la
     * persona salga de donde salga --equipo, licencias--, asi que las dos
     * definiciones difieren en 56 de los 127 officers. Pero los 56 tienen
     * comision CERO, asi que el marcado sale identico: los mismos tres. Es una
     * propiedad de estos datos, no del metodo; si algun dia alguien con
     * comision solo tuviera un Zoom atribuido, habria que volver a mirarlo.
     */
    const cobraEnNomina = payrollStatus === "located";

    const cargo = cargoDe(persona?.personCode ?? null);
    // La nomina localizada, en positivo. `otherCost` es lo que queda de ella
    // despues de la comision -- ver la nota de la cuenta en OfficerBlock.
    const nominaPos = -block2Total;
    const otherCost = nominaPos - block1Commission;

    officers.push({
      name: nombreBonito(nombre),
      personCode: persona?.personCode ?? null,
      branch: (filas[0]?.branch as string | null) ?? null,
      position: cargo.position,
      area: cargo.area,
      group: cargo.group,
      produced: block1Net,
      commission: block1Commission,
      otherCost,
      net: block1Net - block1Commission - otherCost,
      commissionExceedsPayroll: otherCost < 0,
      loans,
      loansPendingPl: pendientes.length,
      pendingPlBooked,
      loanCount: loans.length,
      volume: loans.reduce((s, l) => s + (l.loan_amount ?? 0), 0),
      block1Margin,
      block1Other,
      block1Revenue,
      block1DirectCosts,
      block1OtherBooked,
      block1Elsewhere,
      loansBranchNotInPl: loans.filter((l) => l.branchNotInPl).length,
      contribution: block1Net - block1Commission,
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
  /*
   * ⚠ DENTRO DE UNA SUCURSAL NO SE AÑADE A QUIEN SOLO TIENE NOMINA.
   *
   * La nomina de una persona NO tiene sucursal de produccion: sale de las
   * cuentas de compensacion y no se puede repartir. Sin esto, cada sucursal
   * enseñaba a las 132 personas de la empresa --37 productores en las cuatro
   * que se midieron-- con su coste entero contra la produccion de esa sola
   * sucursal, y el neto salia en -2,6 millones en todas. Leido literal, cada
   * sucursal parecia hundida.
   *
   * Dentro de una sucursal la pregunta es "quien cerro AQUI", asi que solo
   * salen los que tienen cierres en ella.
   */
  const soloConCierres = branches.length > 0;

  for (const [id, filas] of nominaPorPersona) {
    if (soloConCierres) continue;
    if (usados.has(id)) continue;
    const persona = censo.people.find((p) => idDe(p) === id);
    const fragil = nominaFragil.get(id) ?? [];
    const block2Total = filas.reduce((s, r) => s + r.amount, 0);
    const cargoSinCierres = cargoDe(persona?.personCode ?? null);
    officers.push({
      name: nombreBonito(persona?.displayName ?? id),
      personCode: persona?.personCode ?? null,
      branch: null,
      position: cargoSinCierres.position,
      area: cargoSinCierres.area,
      group: cargoSinCierres.group,
      // Sin cierres no hay nada producido ni comision que restar: su cuenta es
      // solo el coste, en negativo. Que un procesador salga asi NO es un
      // hallazgo -- es su trabajo, y por eso va en su propio grupo.
      produced: 0,
      commission: 0,
      otherCost: -block2Total,
      net: block2Total,
      commissionExceedsPayroll: false,
      loans: [],
      loanCount: 0,
      // Sin cierres no puede haber ninguno pendiente de P&L.
      loansPendingPl: 0,
      pendingPlBooked: 0,
      volume: 0,
      block1Margin: 0,
      block1Other: 0,
      block1Revenue: 0,
      block1DirectCosts: 0,
      block1OtherBooked: 0,
      block1Elsewhere: 0,
      loansBranchNotInPl: 0,
      contribution: 0,
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
