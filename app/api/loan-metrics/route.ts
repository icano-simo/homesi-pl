import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import {
  normalizeLoanBranch,
  prestamoEntraEnLente,
  type AffinityLens,
  resolveBaseBranches,
  baseIsDivisionWide,
} from "@/lib/loan-branch";
import { getClosedLoans } from "@/lib/loan-source";
import { categoriaDe } from "@/lib/payroll-categories";
import { tieneDesgloseDeNomina, DESGLOSE_GL_CODE } from "@/lib/payroll-breakdown";

export const dynamic = "force-dynamic";

const PAGE = 1000;
const IN_CHUNK = 500;

const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];


type OfficialRow = {
  loan_number: string;
  loan_info_channel: string | null;
  loan_amount: number | string | null;
  branch: string | null;
  month?: string | null;
  year?: number | null;
  b2b: boolean;
  processing: boolean;
  support_on_demand: boolean;
  affinity: boolean;
  recruitment: boolean;
};

export interface MonthMetrics {
  total: number; banked: number; brokered: number; other: number;
  amount_total: number; amount_banked: number; amount_brokered: number; amount_other: number;
  b2b: number; processing: number; support_on_demand: number; affinity: number; recruitment: number;
}

function emptyMetrics(): MonthMetrics {
  return {
    total: 0, banked: 0, brokered: 0, other: 0,
    amount_total: 0, amount_banked: 0, amount_brokered: 0, amount_other: 0,
    b2b: 0, processing: 0, support_on_demand: 0, affinity: 0, recruitment: 0,
  };
}

const money = (v: number | string | null | undefined): number => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Channel bucket.
 *
 * LIKE 'Banked%' rather than = 'Banked - Retail': the only value present today
 * is "Banked - Retail", but the name says a second banked channel is expected
 * and an equality test would silently drop it. Verified equivalent on the
 * current data — both match the same 340 rows and the same $121,608,969.
 *
 * Anything else, INCLUDING NULL, lands in `other`. The previous version tested
 * `else if (o.loan_info_channel)`, so a null channel counted towards the total
 * and towards no bucket at all: the breakdown quietly failed to add up to the
 * figure printed beside it.
 */
function channelOf(c: string | null): "banked" | "brokered" | "other" {
  const v = (c ?? "").trim();
  if (v.startsWith("Banked")) return "banked";
  if (v === "Brokered") return "brokered";
  return "other";
}

/** Accumulates one loan into a month bucket. Counts and amounts together, from
 *  the same row, so the two can never describe different sets of loans. */
function accumulate(m: MonthMetrics, o: OfficialRow) {
  const amt = money(o.loan_amount);
  const bucket = channelOf(o.loan_info_channel);

  m.total++;
  m.amount_total += amt;
  if (bucket === "banked")        { m.banked++;   m.amount_banked   += amt; }
  else if (bucket === "brokered") { m.brokered++; m.amount_brokered += amt; }
  else                            { m.other++;    m.amount_other    += amt; }

  if (o.b2b)               m.b2b++;
  if (o.processing)        m.processing++;
  if (o.support_on_demand) m.support_on_demand++;
  if (o.affinity)          m.affinity++;
  if (o.recruitment)       m.recruitment++;
}

/*
 * Los prestamos, del espejo.
 *
 * ⚠ SE ADAPTA EN EL BORDE Y NO SE REESCRIBE LO DE ABAJO. Todo lo que sigue
 * --normalizeLoanBranch, el bucket de canal, accumulate-- se queda intacto y
 * sigue trabajando sobre `OfficialRow`. Reescribir esa logica al mismo tiempo
 * que se cambia la fuente haria imposible saber cual de las dos cosas movio una
 * cifra.
 *
 * ⚠ EL MAPEO SE VERIFICO CAMPO A CAMPO ANTES DE ESCRIBIRLO, sobre los 433
 * prestamos que estan en las dos fuentes:
 *
 *     canal      loan_channel      vs loan_info_channel     0 diferencias
 *     importe    total_loan_amount vs loan_amount           0 diferencias
 *     affinity   strategy='Affinity' vs affinity            0 diferencias
 *     sucursal   branch            vs branch                1 diferencia
 *     recruit.   strategy='Recruitment' vs recruitment      2 diferencias
 *
 * Las tres que no son cero, una por una, porque una cifra que se mueve sin
 * explicacion es peor que una cifra mal:
 *
 *   - 150002050394 (Anthony Robert DiToma): el archivo dice sucursal 150, el
 *     espejo 733. El numero de prestamo empieza por 150, asi que el archivo
 *     parece haberla tomado del prefijo. Un prestamo.
 *   - 747002052489 (Gian Laino): el archivo lo marca recruitment y el espejo lo
 *     clasifica B2B. Es EL MISMO prestamo del unico b2bDiscrepa, y eso lo
 *     explica: quien lo clasifico a mano no dijo solo "no es B2B", dijo "es
 *     Recruitment". La discrepancia es coherente en dos campos a la vez, o sea
 *     una disputa de clasificacion de verdad.
 *   - 710001998384 (Sergio Vermejo): el espejo lo clasifica Recruitment y el
 *     archivo no. Es su unico cierre.
 *
 * Neto sobre `recruitment`: entra uno y sale otro. El total no se mueve, pero
 * no son los mismos prestamos, y por eso queda escrito.
 */
async function fetchOfficials(
  years: number[],
  loanNumbers: string[] | null,
  /*
   * ⚠ LA LENTE SE APLICA AQUI, SOBRE LOS CIERRES, y no sobre el resultado ya
   * agregado: el loan count, el volumen y los bps salen todos de esta lista, y
   * filtrar despues obligaria a filtrar tres veces y a acertar las tres.
   *
   * `prestamoEntraEnLente` lleva dentro la guarda de sucursal: un cierre de la
   * 747 pasa en las tres lentes, porque la lente parte la 716 en dos y no
   * reclasifica la division entera.
   */
  lente: AffinityLens = "ambas",
): Promise<OfficialRow[]> {
  if (loanNumbers !== null && loanNumbers.length === 0) return [];

  // 494 filas hoy: se traen enteras y se filtra en memoria. Es tambien donde el
  // filtro de sucursal NO se aplica, por lo mismo de siempre -- necesita
  // normalizeLoanBranch antes, y eso no se puede expresar como predicado.
  const todos = await getClosedLoans();
  const pedidos = loanNumbers === null ? null : new Set(loanNumbers);

  return todos
    .filter((l) => (pedidos ? pedidos.has(l.loanNumber) : true))
    .filter((l) => prestamoEntraEnLente(l.branch, l.isAffinity, lente))
    .map((l) => {
      // `closing_month` es un date; abajo se agrupa por nombre de mes y año.
      const [y, m] = (l.closingMonth ?? "").split("-");
      const anio = Number(y) || null;
      return {
        loan_number: l.loanNumber,
        loan_info_channel: l.loanChannel,
        loan_amount: l.loanAmount,
        branch: l.branch,
        month: m ? MONTH_NAMES[Number(m) - 1] ?? null : null,
        year: anio,
        // Las tres manuales salen de loan_manual_flags, que no se toca. Sin
        // fila de flags NO es "false" en el dato, pero aqui cuenta como no
        // marcado, que es lo que hacia el archivo con sus columnas booleanas.
        b2b: l.b2bManual === true,
        processing: l.processing === true,
        support_on_demand: l.supportOnDemand === true,
        // Estas dos salen de `strategy`, no de columnas propias.
        affinity: l.strategy === "Affinity",
        recruitment: l.strategy === "Recruitment",
      } satisfies OfficialRow;
    })
    .filter((o) => (years.length ? o.year !== null && years.includes(o.year) : true));
}

/**
 * Lo que se le pago al loan officer por estos prestamos, de comp.loan_commission.
 *
 * ⚠ NO ES UNA CUENTA DEL P&L, Y ESO GOBIERNA COMO SE ENSEÑA. Viene de
 * Compensafe, no tiene gl_code y no cuadra contra el libro mayor: en la rejilla
 * de cuentas no puede salir como una fila mas, porque la rejilla ES el libro.
 * Va como linea aparte, diciendo de donde sale -- igual que en las tarjetas del
 * modulo por Loan Officer.
 *
 * ⚠ Y `sin_comision` NO ES UN DETALLE. De los 62 cierres de "716 puro", SEIS no
 * tienen fila en Compensafe: su comision no es cero, es desconocida. Enseñar
 * -220.461,55 a secas afirmaria que esos seis no costaron nada. El contador
 * viaja para que la pantalla pueda decirlo.
 *
 * ⚠ QUE ESTO NO SE CUENTA DOS VECES CON EL MODULO POR LOAN OFFICER: las dos
 * cifras existen, pero contestan a poblaciones distintas --una linea de negocio
 * contra una persona-- y NINGUNA suma en la otra. Ademas la rejilla del P&L no
 * la contiene en absoluto: la comision no esta en `pl_transactions`, asi que el
 * total de la rejilla y el de la linea de negocio son dos numeros distintos a
 * proposito, y el bloque lo dice.
 */
async function comisionDe(loanNumbers: string[]) {
  if (loanNumbers.length === 0)
    return { total: 0, loans: 0, sin_comision: 0, porPrestamo: new Map<string, number>() };
  const comp = createServerClient("comp");
  const encontradas = new Map<string, number>();
  for (let i = 0; i < loanNumbers.length; i += IN_CHUNK) {
    const trozo = loanNumbers.slice(i, i + IN_CHUNK);
    const { data, error } = await comp
      .from("loan_commission")
      .select("loan_number,lo_pay")
      .in("loan_number", trozo);
    // Que Compensafe falle no puede tumbar el panel: sin ella la comision es
    // desconocida para TODOS, que es lo que la pantalla ya sabe decir.
    if (error) return { total: 0, loans: 0, sin_comision: loanNumbers.length, porPrestamo: new Map<string, number>() };
    for (const r of data ?? []) {
      if (r.lo_pay != null) encontradas.set(String(r.loan_number), Number(r.lo_pay));
    }
  }
  let total = 0;
  for (const v of encontradas.values()) total += v;
  return {
    total,
    loans: encontradas.size,
    sin_comision: loanNumbers.length - encontradas.size,
    porPrestamo: encontradas,
  };
}

/**
 * Cuanto de la cuenta 60105 DE ESTA SUCURSAL es comision de prestamos Affinity.
 *
 * ⚠ ES LA VIA QUE HACE POSIBLE RESTARLA, y no la que parecia. Las 130 filas de
 * 60105 en el P&L no tienen `loan_number` --verificado, ninguna-- asi que desde
 * el libro no hay forma de saber cuales son de Affinity. Pero
 * `comp.payroll_transaction` SI lo trae en sus lineas de comision, y esa tabla
 * es de donde sale el desglose de la cuenta. O sea que el reparto no se
 * inventa: se lee de la fuente que ya explica esa cuenta.
 *
 * ⚠ SE FILTRA POR `branch_code`, Y ESO NO ES UN DETALLE -- son 500 euros de
 * diferencia y solo una de las dos cifras es la correcta:
 *
 *     payroll_transaction · branch_code = 716   20.363,79   35 lineas
 *     payroll_transaction · cualquier branch    20.863,79   36
 *     comp.loan_commission · los 39 cierres     20.863,79   39
 *
 * La linea que sobra es de GIAN LAINO, sucursal 747, 500,00 en un prestamo de
 * Affinity. Su comision NO esta en el 60105 de la 716 -- esta en el de la 747,
 * porque el libro contabiliza donde esta la persona. Restar 20.863,79 quitaria
 * de la 716 quinientos euros que nunca estuvieron ahi.
 *
 * Lo que se resta es lo que la cuenta LLEVA DENTRO, no lo que la linea de
 * negocio COSTO. Son dos preguntas, y esta funcion contesta la primera.
 */
async function comisionAffinityEnLaCuenta(branch: string): Promise<{ total: number; lines: number }> {
  const comp = createServerClient("comp");
  const ar = createServerClient("activity_report");

  const afectados = new Set<string>();
  for (let i = 0; ; i += PAGE) {
    const { data, error } = await ar
      .from("loan_records_v2")
      .select("loan_number")
      .eq("is_affinity", true)
      .range(i, i + PAGE - 1);
    if (error) return { total: 0, lines: 0 };
    for (const r of data ?? []) {
      const ln = (r.loan_number as string | null)?.trim();
      if (ln) afectados.add(ln);
    }
    if (!data || data.length < PAGE) break;
  }
  if (afectados.size === 0) return { total: 0, lines: 0 };

  let total = 0;
  let lines = 0;
  for (let i = 0; ; i += PAGE) {
    const { data, error } = await comp
      .from("payroll_transaction")
      .select("loan_number,amount")
      .eq("branch_code", branch)
      .eq("pay_type", "Commission")
      .range(i, i + PAGE - 1);
    if (error) return { total: 0, lines: 0 };
    for (const r of data ?? []) {
      const ln = (r.loan_number as string | null)?.trim();
      if (ln && afectados.has(ln)) {
        total += Number(r.amount ?? 0);
        lines++;
      }
    }
    if (!data || data.length < PAGE) break;
  }
  return { total, lines };
}

/**
 * Lo que el LIBRO dice de la cuenta, para poder enfrentarlo a Compensafe.
 *
 * ⚠ `loan_number is null`, igual que el resto de la nomina del modulo: las
 * lineas de 60105 no cuelgan de ningun prestamo, y pedir las que si colgaran
 * traeria otra cosa.
 */
async function cuenta60105De(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  branch: string,
  years: number[],
): Promise<number> {
  let q = supabase
    .from("pl_transactions")
    .select("movement")
    .eq("gl_code", DESGLOSE_GL_CODE)
    .eq("branch", branch)
    .is("loan_number", null);
  if (years.length) q = q.in("year", years);
  const { data, error } = await q;
  if (error || !data) return 0;
  return (data as { movement: number | null }[]).reduce((s, r) => s + Number(r.movement ?? 0), 0);
}

/**
 * Los componentes de `60105 Loan Officer Payroll` segun Compensafe.
 *
 * ⚠ SE CLASIFICA CON EL MISMO `categoriaDe` QUE EL MODULO POR LOAN OFFICER, y
 * eso incluye su orden: `is_recapture` va ANTES que `is_hourly`, porque las
 * lineas de recuperacion de horas llevan las DOS banderas y al reves contarian
 * como horas cobradas. Dos clasificadores darian dos desgloses de la misma
 * cuenta en la misma app.
 *
 * ⚠ Y EL HUECO SE DEVUELVE, NO SE REPARTE. `unexplained` es la diferencia entre
 * lo que dice el libro y lo que dice Compensafe; repartirla entre los tres
 * componentes afirmaria que las dos fuentes cuadran.
 */
async function desgloseDeNomina(branch: string, cuentaDelLibro: number) {
  const comp = createServerClient("comp");
  const filas = await (async () => {
    const out: Record<string, unknown>[] = [];
    for (let i = 0; ; i += PAGE) {
      const { data, error } = await comp
        .from("payroll_transaction")
        .select("pay_type,is_hourly,is_recapture,amount")
        .eq("branch_code", branch)
        .range(i, i + PAGE - 1);
      if (error) return null;
      out.push(...((data ?? []) as Record<string, unknown>[]));
      if (!data || data.length < PAGE) break;
    }
    return out;
  })();
  // Que Compensafe falle no puede tumbar el panel: sin ella no hay desglose,
  // que es lo que la pantalla ya sabe enseñar.
  if (!filas) return null;

  const suma = { commission: 0, hourly: 0, recapture: 0 };
  for (const r of filas) {
    const cat = categoriaDe({
      pay_type: r.pay_type as string | null,
      is_hourly: r.is_hourly as boolean | null,
      is_recapture: r.is_recapture as boolean | null,
    });
    // Solo las tres que se contabilizan en esta cuenta. Bonus y sueldo van por
    // 60303 y 60125, asi que entran en el desglose de las suyas, no en este.
    if (cat === "commission") suma.commission += Number(r.amount ?? 0);
    else if (cat === "hourly") suma.hourly += Number(r.amount ?? 0);
    else if (cat === "recapture") suma.recapture += Number(r.amount ?? 0);
  }
  const total = suma.commission + suma.hourly + suma.recapture;
  return {
    account: cuentaDelLibro,
    commission: suma.commission,
    hourly: suma.hourly,
    recapture: suma.recapture,
    unexplained: -cuentaDelLibro - total,
  };
}

/** Paged read of the loan numbers a P&L filter selects. */
async function fetchLoanNumbers(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  years: number[], branches: string[], sources: string[], ccIds: string[],
): Promise<string[]> {
  const seen = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = supabase
      .from("pl_transactions")
      .select("loan_number")
      .not("loan_number", "is", null)
      .not("loan_number_incomplete", "eq", true);
    if (years.length)    q = q.in("year", years);
    if (branches.length) q = q.in("branch", branches);
    if (sources.length)  q = q.in("source", sources);
    if (ccIds.length)    q = q.in("cost_center_id", ccIds);

    const { data, error } = await q.order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (const r of data as { loan_number: string }[]) seen.add(r.loan_number);
    if (data.length < PAGE) break;
  }
  return [...seen];
}

export async function GET(req: NextRequest) {
  const supabase = createServerClient();
  const sp = new URL(req.url).searchParams;
  const lenteParam = sp.get("lens");
  const lente: AffinityLens =
    lenteParam === "affinity" || lenteParam === "716" ? lenteParam : "ambas";

  const years    = sp.getAll("year").map(Number).filter(Boolean);
  const branches = sp.getAll("branch");
  const sources  = sp.getAll("source");
  const ccIds    = sp.getAll("cost_center_id");
  const groupBy  = sp.get("group_by");

  try {
    // ── Per-month mode ──────────────────────────────────────────────────────
    if (groupBy === "month") {
      // sources and cost_center_id are properties of pl_transactions, not of
      // loan_officials, so they narrow the loan list through the transactions
      // that reference those loans. Previously this mode ignored them: the UI
      // offered the filters and the panel answered as if they were not set.
      const narrowByTx = sources.length > 0 || ccIds.length > 0;
      const loanNumbers = narrowByTx
        ? await fetchLoanNumbers(supabase, years, branches, sources, ccIds)
        : null;

      const raw = await fetchOfficials(years, loanNumbers, lente);

      // ONE row set. Everything below is an aggregate of `rows` — the count and
      // the amount for a month are accumulated from the same record in the same
      // pass, so they cannot describe different sets of loans.
      const rows = raw
        .map((o) => ({ ...o, branch: normalizeLoanBranch(o.branch) }))
        .filter((o) => o.branch !== null);

      const excluded = raw.length - rows.length;

      // ── One branch rule, applied once ───────────────────────────────────────
      // The cards and the bps denominator MUST select the same loans. They used
      // to filter separately — the cards on `branches` directly, the base
      // through resolveBaseBranches — and the corporate branch broke the pair:
      // filtering to 700 counted zero loans (nothing normalizes to "700") while
      // the base correctly used every branch. Cards at zero, bps computed off a
      // full denominator.
      //
      // Now there is a single predicate and a single pass, so the two cannot
      // disagree: null means every branch, an array means those branches.
      const effectiveBranches = resolveBaseBranches(branches);
      const inScope = (b: string) => !effectiveBranches || effectiveBranches.includes(b);

      const by_month: Record<string, MonthMetrics> = {};
      const bps_base_by_month: Record<string, { all: number; banked: number; brokered: number }> = {};

      for (const o of rows) {
        if (!o.month) continue;
        if (!inScope(o.branch!)) continue;

        (by_month[o.month] ??= emptyMetrics());
        accumulate(by_month[o.month], o);

        const b = (bps_base_by_month[o.month] ??= { all: 0, banked: 0, brokered: 0 });
        const amt = money(o.loan_amount);
        b.all += amt;
        const bucket = channelOf(o.loan_info_channel);
        if (bucket === "banked") b.banked += amt;
        else if (bucket === "brokered") b.brokered += amt;
      }

      // Branches the user asked for that carry no loans at all. Only meaningful
      // when the filter is actually narrowing: under the corporate rule the
      // effective scope is every branch, and reporting 700 as "unmatched" would
      // warn about the very case the rule exists to handle.
      const present = new Set(rows.map((o) => o.branch!));
      const unmatched_branches = effectiveBranches
        ? effectiveBranches.filter((b) => !present.has(b))
        : [];

      // Invariant: the three buckets must reconstruct the total. If a channel
      // ever escapes categorisation, say so rather than printing a breakdown
      // that does not add up to the figure above it.
      const drift = Object.entries(by_month)
        .filter(([, m]) =>
          m.banked + m.brokered + m.other !== m.total ||
          Math.abs(m.amount_banked + m.amount_brokered + m.amount_other - m.amount_total) > 0.01)
        .map(([month]) => month);

      return NextResponse.json({
        by_month,
        bps_base_by_month,
        base_is_division_wide: baseIsDivisionWide(branches),
        unmatched_branches,
        excluded_loans: excluded,
        bucket_drift_months: drift,
        /*
         * ⚠ `inScope`, NO `rows` A SECAS. `fetchOfficials` NO aplica el filtro
         * de sucursal --lo dice su propia nota-- asi que `rows` son los cierres
         * de toda la division. Sin este filtro la comision salia 952.168,48 en
         * 399 prestamos donde tenian que ser 20.863,79 en 39: el numero de la
         * division entera bajo el rotulo de Affinity.
         *
         * Se usa el MISMO predicado que las tarjetas y la base de bps, por lo
         * mismo que dice la nota de arriba: tres filtros escritos aparte son
         * tres sitios donde pueden dejar de coincidir.
         */
        commission: await (async () => {
          const enAlcance = rows.filter((o) => inScope(o.branch!));
          const c = await comisionDe(enAlcance.map((o) => o.loan_number));
          /*
           * ⚠ POR MES DE CIERRE DEL PRESTAMO, no de pago. Compensafe agrupa por
           * fecha de cierre --esta medido en PRODUCTION_PAY_GL_CODES-- y la
           * rejilla enseña meses: poner la comision en el mes de pago la
           * separaria del revenue del mismo prestamo, que es lo unico contra lo
           * que tiene sentido leerla.
           */
          const by_month: Record<string, number> = {};
          for (const o of enAlcance) {
            const v = c.porPrestamo.get(o.loan_number);
            if (v == null || !o.month) continue;
            by_month[o.month] = (by_month[o.month] ?? 0) + v;
          }
          return {
            total: c.total,
            loans: c.loans,
            sin_comision: c.sin_comision,
            by_month,
          };
        })(),
        /*
         * El desglose de 60105, solo donde reconcilia. La lista de sucursales y
         * el porque --y sobre todo el porque NO en las otras once-- viven en
         * lib/payroll-breakdown.ts, no aqui.
         */
        /*
         * ⚠ NULL CON LA LENTE DE AFFINITY, y no es un caso raro: con esa lente
         * NO HAY NI UNA fila de 60105 en la rejilla --verificado ejecutando:
         * 130 filas con "716 + Affinity", 130 con "716 only", CERO con
         * "Affinity"-- porque la nomina no cuelga de ningun prestamo y solo las
         * filas AE se identifican como de Affinity. Devolver el desglose ahi
         * pintaria el detalle de una fila que no esta en la tabla.
         */
        payroll_breakdown:
          tieneDesgloseDeNomina(branches) && lente !== "affinity"
            ? await desgloseDeNomina(branches[0], await cuenta60105De(supabase, branches[0], years))
            : null,
        /*
         * Cuanto de la cuenta 60105 es comision de prestamos Affinity, para
         * poder sacarlo de la lente de "716 puro".
         *
         * ⚠ SOLO EN ESA LENTE. En "ambas" la cuenta tiene que quedarse entera
         * --es el libro de la 716 completo-- y en "Affinity" no hay cuenta de
         * la que sacar nada.
         */
        affinity_in_account:
          tieneDesgloseDeNomina(branches) && lente === "716"
            ? await comisionAffinityEnLaCuenta(branches[0])
            : null,
      });
    }

    // ── Total mode ──────────────────────────────────────────────────────────
    const loanNumbers = await fetchLoanNumbers(supabase, years, branches, sources, ccIds);
    if (loanNumbers.length === 0) return NextResponse.json(emptyMetrics());

    const raw = await fetchOfficials([], loanNumbers, lente);
    const totals = emptyMetrics();
    for (const o of raw) {
      if (normalizeLoanBranch(o.branch) === null) continue;
      accumulate(totals, o);
    }
    return NextResponse.json(totals);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
