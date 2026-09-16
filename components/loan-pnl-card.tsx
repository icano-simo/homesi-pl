"use client";

import { Fragment } from "react";
import { CONCEPT_ORDER, conceptLabel } from "@/lib/loan-detail-accounts";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * LA TARJETA DE UN PRESTAMO, UNA SOLA PARA LAS DOS PANTALLAS
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * La pintan el mini P&L del modal de sucursal y el modulo de P&L por Loan
 * Officer. Antes eran dos componentes parecidos, y ESE es el patron que este
 * proyecto lleva desmontando: el neto de Table List y el de las Mini P&L Cards
 * ya dieron cifras distintas con nombres parecidos, sin que nada fallara.
 *
 * ⚠ LO QUE CAMBIA ENTRE LAS DOS PANTALLAS VIAJA COMO PROPS, no como una copia:
 *
 *   `commission`  el modulo de LO resta la comision del loan officer; el mini
 *                 P&L del modal de sucursal todavia no. Null = no se enseña la
 *                 linea, y entonces el total es solo revenue + costes directos.
 *   `elsewhere`   solo el modulo de LO restringe el revenue a la sucursal del
 *                 prestamo, asi que solo el tiene algo que enseñar fuera.
 *   `total`       su etiqueta y su valor los pone quien la usa, porque las dos
 *                 pantallas NO contestan la misma pregunta con ella. Ver abajo.
 *
 * ⚠ Y EL TOTAL ES LA DIFERENCIA QUE NO SE PUEDE RESOLVER DESDE AQUI:
 *
 *     mini P&L      TOTAL REVENUE        revenue + costes directos
 *     modulo de LO  TOTAL CONTRIBUTION   lo mismo, MENOS la comision del LO
 *
 * No son dos nombres del mismo numero: son dos numeros. Unificarlos significa
 * decidir si el P&L de sucursal resta la comision del loan officer en cada
 * tarjeta, y eso mueve la cifra de cabecera de esa pantalla. Es una decision de
 * negocio y no se toma desde un componente de presentacion.
 */

export interface TarjetaLinea {
  gl_code: string | null;
  gl_name: string | null;
  category_7: string | null;
  /** El grupo contable, que decide en que peldaño cae la linea. */
  category_6?: string | null;
  branch: string | null;
  amount: number;
  /** Solo el modulo de LO lo usa: la linea esta en la sucursal del prestamo. */
  in_branch?: boolean;
  /** Para el tooltip: es lo unico que distingue dos filas de la misma cuenta. */
  check_description?: string | null;
}

export interface TarjetaPrestamoProps {
  /*
   * ─── LA FICHA: HUECOS, NO CAMPOS DE UN PRESTAMO ──────────────────────────
   *
   * ⚠ SE LLAMAN `title`/`subtitle`/`meta` Y NO `loan_number`/`borrower_name`
   * A PROPOSITO. Esta tarjeta la usan tres cosas: un prestamo, el resumen de un
   * mes y el resumen de un loan officer, y las tres llenan los mismos huecos
   * con lo suyo:
   *
   *             title            tag       subtitle        meta
   *   prestamo  numero           sucursal  prestatario     programa · officer
   *   mes       "JULY 2026"      —         "Banked loans"  n prestamos
   *   officer   "ALL 24 CLOSINGS" sucursal  nombre         cargo · area
   *
   * Con nombres de prestamo, la tarjeta de totales habria tenido que pasar su
   * nombre como `borrower_name`, y eso es exactamente como se empieza a
   * justificar un segundo componente.
   */
  title: string;
  /** La cajita de arriba a la derecha. */
  tag?: string | null;
  subtitle?: string | null;
  meta?: string | null;
  /** El importe de la ficha, y la base de TODOS los bps de la tarjeta. */
  amount: number | null;
  /**
   * La sucursal contra la que se compara la de cada linea, para marcar "@700".
   * Null en las tarjetas que suman varios prestamos: ahi no hay una sola.
   */
  branch?: string | null;
  b2b?: boolean;
  processing?: boolean;
  support_on_demand?: boolean;
  /** Avisos propios de cada pantalla: "no margin", "pending P&L", meses ajenos. */
  signals?: React.ReactNode;

  lineas: TarjetaLinea[];
  /** Null cuando la pantalla no resta comision. Ver la nota de arriba. */
  commission?: number | null;
  total: { label: string; value: number | null };
  /** La seccion de la 700. Solo el modulo de LO la tiene. */
  elsewhere?: { label: string; lineas: TarjetaLinea[] }[];
  /**
   * Bloques que solo existen en una de las tarjetas -- hoy, la nomina del
   * periodo y la comparacion comision/nomina del resumen por loan officer.
   *
   * ⚠ VAN DENTRO DEL CUERPO DE LA TARJETA, no debajo ni en otra caja: son
   * bloques con el mismo formato que los peldaños, y lo unico que los
   * distingue es que solo una de las tarjetas los tiene. Si eso la hace la mas
   * alta de la fila, ese pasa a ser el alto de todas -- no se recorta.
   */
  extra?: React.ReactNode;
}

const usdExacto = (n: number) =>
  new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

/**
 * ⚠ bps SOBRE EL IMPORTE DEL PRESTAMO, EN CADA LINEA. Es lo que el mini P&L
 * tenia y el modulo de LO no, y es la unica lectura que permite comparar una
 * cuenta entre dos prestamos de tamaño distinto: en dolares gana siempre el
 * grande.
 */
const bps = (v: number, base: number | null | undefined) =>
  base ? `${((v / base) * 10000).toFixed(1)} bps` : "— bps";

/** El color sale del efecto sobre el neto y de nada mas, igual en los dos sitios. */
function colorImporte(v: number) {
  if (v === 0) return "text-slate-300 font-normal";
  return v < 0 ? "text-rose-600 font-medium" : "text-slate-800";
}

/**
 * Los peldaños en que se reparte la tabla de cuentas.
 *
 * El mini P&L no manda `category_6` en sus lineas, asi que todas caen en el
 * primero y la tarjeta sale con un solo bloque -- que es como estaba. Cuando lo
 * manda, la tabla se parte igual que en el modulo de LO.
 */
const PELDAÑOS = [
  { key: "revenue", label: "Branch gross revenue", grupo: "Revenue" },
  { key: "direct", label: "Direct production costs", grupo: "Direct Production Costs" },
  { key: "other", label: "Other booked to the loan", grupo: null },
] as const;

function peldañoDe(c6: string | null | undefined) {
  if (c6 == null) return "revenue" as const;
  if (c6 === "Revenue") return "revenue" as const;
  if (c6 === "Direct Production Costs") return "direct" as const;
  return "other" as const;
}

/**
 * ⚠ ORDEN FIJO POR CONCEPTO, NO POR IMPORTE, y es la unica razon por la que
 * dos tarjetas se pueden comparar de un vistazo. Por importe, cada prestamo
 * saca "Back-end Margin" en un renglon distinto y hay que buscarlo en cada
 * tarjeta. Lo de fuera de la lista va detras, y entre si por importe.
 *
 * Dentro de un mismo concepto se conserva el orden de llegada: son filas crudas
 * y su secuencia cuenta algo -- el cobro primero y su traslado despues.
 */
function ordenarPorConcepto(filas: TarjetaLinea[]): TarjetaLinea[] {
  const rango = (x: TarjetaLinea) => {
    const i = CONCEPT_ORDER.indexOf(conceptLabel(x.gl_name, x.category_7));
    return i === -1 ? CONCEPT_ORDER.length : i;
  };
  return [...filas].sort((a, b) => {
    const ra = rango(a), rb = rango(b);
    if (ra !== rb) return ra - rb;
    if (ra < CONCEPT_ORDER.length) return 0;       // dentro del concepto, sin tocar
    return Math.abs(b.amount) - Math.abs(a.amount); // el resto, por importe
  });
}

function Linea({ x, importeBase, sucursal }: {
  x: TarjetaLinea; importeBase: number | null; sucursal: string | null;
}) {
  /*
   * ⚠ LA SUCURSAL SALE DE LA LINEA. Cuando venia de un mapa por category_7
   * marcaba "@700" en TODAS las filas de "Fee Income, Net" en cuanto una sola
   * estuviera alli -- y con las filas crudas eso es justo lo que hay que
   * distinguir: cual de las tres filas de 41205 es la de corporativo.
   */
  const fuera = !!x.branch && !!sucursal && x.branch !== sucursal;
  return (
    <div className="flex items-baseline justify-between gap-2 px-3 py-0.5 text-[11px]">
      <span className="truncate text-slate-600">
        {/* El gl_code, para poder cuadrar la linea contra la contabilidad:
            category_7 junta varias cuentas en una cifra que no reconcilia con
            nada, asi que el nombre solo no basta. */}
        <span className="mr-1.5 font-mono text-[9px] text-slate-400">{x.gl_code ?? "—"}</span>
        {/*
          * ⚠ EL NOMBRE DEL NEGOCIO, QUE NO SIEMPRE ES category_7. La
          * contabilidad llama "BM Margin" a lo que el negocio llama "Back-end
          * Margin", y "LO Margin" a "Front-end Margin" -- ese ultimo
          * especialmente enganoso, porque 41305 NO es compensacion del loan
          * officer pese al nombre. Pero "Lender Credits" (41225) y "Other HUD
          * Fees, Net" (41205) son al reves: su category_7 es "Fee Income, Net"
          * para los dos, y usarlo los fundiria en una linea.
          *
          * `conceptLabel` resuelve las dos direcciones. Lo que quede detras --el
          * otro nombre-- va en gris, para quien busque la cuenta por como la ve
          * en el libro mayor.
          */}
        {conceptLabel(x.gl_name, x.category_7)}
        {fuera && (
          <span
            title={`Booked in branch ${x.branch}, while the loan is branch ${sucursal}. Common and not an error: part of the margin is booked in 700 by design.`}
            className="ml-1 rounded bg-slate-200/70 px-1 py-0.5 font-mono text-[9px] text-slate-600"
          >
            @{x.branch}
          </span>
        )}
      </span>
      <span
        title={x.check_description ?? (x.amount > 0 ? "Adds to the net" : x.amount < 0 ? "Takes from the net" : "No amount")}
        className={`shrink-0 font-mono tabular-nums text-xs ${colorImporte(x.amount)}`}
      >
        {usdExacto(x.amount)}
        <span className="ml-1 font-mono text-[11px] font-normal text-slate-500">
          {bps(x.amount, importeBase)}
        </span>
      </span>
    </div>
  );
}

export function LoanPnlCard(p: TarjetaPrestamoProps) {
  const porPeldaño = new Map<string, TarjetaLinea[]>();
  for (const x of p.lineas) {
    const k = peldañoDe(x.category_6);
    porPeldaño.set(k, [...(porPeldaño.get(k) ?? []), x]);
  }

  const perdida = (p.total.value ?? 0) < 0;
  const hayFuera = !!p.elsewhere && p.elsewhere.some((s) => s.lineas.length > 0);

  return (
    /*
     * ⚠ NINGUNA TARJETA SCROLLEA POR DENTRO. El contenido cabe entero, y el
     * alto lo iguala la fila: "items-stretch", que es el defecto de un flex-row,
     * estira todas a la mas alta, y la que tiene menos contenido deja hueco
     * abajo en vez de encogerse. Eso es lo que mantiene la linea de base y
     * permite leer la fila en horizontal.
     *
     * ⚠ NO SE PONE ALTO FIJO. Lo tuvo --h-[30rem] con scroll dentro-- y era
     * peor de las dos maneras: recortaba la tarjeta que totaliza y metia una
     * segunda barra dentro de la del panel.
     *
     * El ancho SI es fijo: es una fila de tarjetas y el scroll horizontal es su
     * forma.
     */
    <div className="flex w-[340px] shrink-0 flex-col overflow-hidden rounded-2xl border border-slate-200/90 bg-white shadow-xs transition-all hover:border-[#A6DEFF]">
      <div className="flex min-h-0 flex-1 flex-col">
        {/* ── La ficha del prestamo ─────────────────────────────────────── */}
        <div className="flex shrink-0 flex-col gap-1 border-b border-slate-200 bg-slate-100/90 p-3.5 text-xs font-bold text-[#001A40]">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-mono">{p.title}</span>
            {p.tag && (
              <span className="shrink-0 rounded bg-white px-1.5 py-0.5 font-mono text-[10px]">{p.tag}</span>
            )}
          </div>
          <span className="truncate font-semibold text-slate-600">{p.subtitle ?? "—"}</span>
          {/* Identidad, no dato: contesta "de quien es esto y de que tipo" antes
              que ninguna cifra. */}
          <span className="truncate text-[10px] font-normal text-slate-500">{p.meta ?? "—"}</span>
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono tabular-nums text-slate-500">
              {p.amount == null ? "—" : `$${p.amount.toLocaleString("en-US", { maximumFractionDigits: 0 })}`}
            </span>
            <span className="inline-flex items-center gap-0.5">
              {p.b2b && <Etiqueta label="B2B" />}
              {p.support_on_demand && <Etiqueta label="On Demand" />}
              {p.processing && <Etiqueta label="Processing" />}
              {p.signals}
            </span>
          </div>
        </div>

        {/* ── Las cuentas, por peldaño ──────────────────────────────────── */}
        {/* ⚠ SIN flex-1. Lo tuvo, y empujaba el banner al fondo de la tarjeta:
            en la de totales quedaba un hueco grande entre los costes y el
            total. El hueco que sobra en una tarjeta baja se queda DEBAJO de
            todo, que es donde no estorba. */}
        <div className="px-3 pt-2">
          {p.lineas.length === 0 && (
            <p className="px-3 pb-1 text-[10px] italic text-slate-400">No entries on this loan</p>
          )}
          {PELDAÑOS.map((esc) => {
            const filas = ordenarPorConcepto(porPeldaño.get(esc.key) ?? []);
            // El peldaño sin lineas no se enseña: un renglon permanente a cero
            // en 481 de 482 prestamos es ruido.
            if (filas.length === 0) return null;
            const subtotal = filas.reduce((s, x) => s + x.amount, 0);
            return (
              <Fragment key={esc.key}>
                <div className="my-1.5 flex items-center justify-between rounded-lg border border-emerald-200/60 bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-900">
                  <span className="uppercase tracking-wide">{esc.label}</span>
                  <span className={`font-mono tabular-nums ${subtotal < 0 ? "text-rose-700" : ""}`}>
                    {usdExacto(subtotal)}
                    <span className="ml-1 font-normal opacity-70">{bps(subtotal, p.amount)}</span>
                  </span>
                </div>
                {filas.map((x, i) => (
                  <Linea key={`${esc.key}-${x.gl_code}-${i}`} x={x} importeBase={p.amount} sucursal={p.branch ?? null} />
                ))}
              </Fragment>
            );
          })}

          {/*
            * ⚠ LA COMISION ES UN PELDAÑO SIN CUENTAS Y HAY QUE DECIRLO: sale de
            * comp.loan_commission y no del P&L, asi que no tiene gl_code que
            * enseñar y no se puede cuadrar contra el libro mayor como las de
            * arriba. Un bloque con la misma pinta y sin lineas se leeria como un
            * fallo de carga.
            */}
          {p.commission !== undefined && (
            <div className="my-1.5 flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-bold text-slate-700">
              {/*
                * ⚠ LA ETIQUETA NOMBRA EXACTAMENTE LO QUE RESTA, y con las
                * mismas palabras que la linea de donde sale. Decia "LO
                * commission" mientras mas abajo la tarjeta enseña "Commission
                * on loans" y "Payroll this period": tres nombres para dos
                * cifras, y no habia forma de saber cual entraba en el total.
                *
                * La que resta es "Commission on loans" -- la de Compensafe por
                * los cierres del periodo-- y NO la nomina. La nomina se resta
                * en la otra cuenta, la de abajo, que es otra pregunta.
                */}
              <span className="uppercase tracking-wide">
                &minus; Commission on loans
                <span className="ml-1.5 font-normal normal-case tracking-normal text-slate-400">
                  from Compensafe, not payroll
                </span>
              </span>
              <span className="font-mono tabular-nums text-rose-700">
                {p.commission == null
                  ? <span className="text-slate-400" title="This loan does not cross with Compensafe. Not the same as a zero commission.">not known</span>
                  : <>
                      {usdExacto(-p.commission)}
                      <span className="ml-1 font-normal opacity-70">{bps(-p.commission, p.amount)}</span>
                    </>}
              </span>
            </div>
          )}

          {/* Lo que solo tiene una de las tarjetas, con el mismo formato de
              bloque y dentro del mismo cuerpo que scrollea. Ver `extra`. */}
          {p.extra}
        </div>

      </div>

      {/*
        * ── El banner del total ──────────────────────────────────────────────
        *
        * ⚠ LA CUENTA CIERRA AQUI, Y LO DE LA 700 VA DEBAJO. Estaba encima del
        * banner porque el banner iba pegado al fondo de la tarjeta, y leido de
        * arriba abajo eso ponia los 8.124,38 de corporativo ANTES del total --
        * o sea, pareciendo que participaban en la resta. No participan:
        * 29.509,80 - 123,93 - 15.370,22 = 14.015,65 y los 8.124,38 quedan
        * fuera. Que se vea por la POSICION y no solo por la etiqueta.
        */}
      <div
        className={`flex shrink-0 items-center justify-between p-3 text-xs font-bold shadow-xs ${
          hayFuera ? "" : "rounded-b-2xl"
        } ${perdida ? "border-t border-rose-200 bg-rose-100 text-rose-900" : "bg-[#001A40] text-white"}`}
      >
        <span className="text-[10px] uppercase leading-tight tracking-wide opacity-80">
          {p.total.label}
        </span>
        <span className="text-right">
          {/* ⚠ LA CIFRA MAS GRANDE DE LA TARJETA. Es la respuesta, y al mismo
              cuerpo que una linea de cuenta se perdia entre ellas. */}
          <span className={`block font-mono text-xl font-bold leading-none tabular-nums ${
            perdida ? "text-rose-700" : "text-emerald-300"
          }`}>
            {p.total.value == null ? "—" : usdExacto(p.total.value)}
          </span>
          <span className={`mt-0.5 block font-mono text-[11px] ${perdida ? "text-rose-800" : "text-emerald-400"}`}>
            {p.total.value == null ? "— bps" : bps(p.total.value, p.amount)}
          </span>
        </span>
      </div>

      {/* Fuera de la cuenta: debajo del total, en gris y sobre otro fondo. */}
      {hayFuera && (
        <div className="shrink-0 rounded-b-2xl border-t-2 border-slate-300 bg-slate-100 px-3 py-2">

          {p.elsewhere!.map((s) => s.lineas.length === 0 ? null : (
            <Fragment key={s.label}>
              <div className="mt-1 flex items-center justify-between text-[10px] font-semibold text-slate-600">
                <span>{s.label}</span>
                <span className="font-mono tabular-nums">
                  {usdExacto(s.lineas.reduce((a, x) => a + x.amount, 0))}
                </span>
              </div>
              <div className="-mx-3 opacity-70">
                {s.lineas.map((x, i) => (
                  <Linea key={`${s.label}-${i}`} x={x} importeBase={p.amount} sucursal={p.branch ?? null} />
                ))}
              </div>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

function Etiqueta({ label }: { label: string }) {
  return (
    <span className="rounded-full border border-slate-300 bg-white px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-slate-600">
      {label}
    </span>
  );
}
