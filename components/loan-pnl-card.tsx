"use client";

import { Fragment } from "react";

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
  loan_number: string;
  branch: string | null;
  borrower_name: string | null;
  loan_program: string | null;
  loan_officer: string | null;
  loan_amount: number | null;
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
            nada. */}
        <span className="mr-1.5 font-mono text-[9px] text-slate-400">{x.gl_code ?? "—"}</span>
        {x.gl_name ?? x.category_7 ?? "—"}
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

  return (
    <div className="flex w-[340px] shrink-0 flex-col justify-between overflow-hidden rounded-2xl border border-slate-200/90 bg-white shadow-xs transition-all hover:border-[#A6DEFF]">
      <div>
        {/* ── La ficha del prestamo ─────────────────────────────────────── */}
        <div className="flex flex-col gap-1 border-b border-slate-200 bg-slate-100/90 p-3.5 text-xs font-bold text-[#001A40]">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono">{p.loan_number}</span>
            <span className="rounded bg-white px-1.5 py-0.5 font-mono text-[10px]">{p.branch ?? "—"}</span>
          </div>
          <span className="truncate font-semibold text-slate-600">{p.borrower_name ?? "—"}</span>
          {/* Programa y officer se leen como identidad, no como dato: contestan
              "de quien es este prestamo y de que tipo" antes que ninguna cifra. */}
          <span className="truncate text-[10px] font-normal text-slate-500">
            {p.loan_program ?? "—"} · {p.loan_officer ?? "—"}
          </span>
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono tabular-nums text-slate-500">
              {p.loan_amount == null ? "—" : `$${p.loan_amount.toLocaleString("en-US", { maximumFractionDigits: 0 })}`}
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
        <div className="px-3 pt-2">
          {p.lineas.length === 0 && (
            <p className="px-3 pb-1 text-[10px] italic text-slate-400">No entries on this loan</p>
          )}
          {PELDAÑOS.map((esc) => {
            const filas = porPeldaño.get(esc.key) ?? [];
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
                    <span className="ml-1 font-normal opacity-70">{bps(subtotal, p.loan_amount)}</span>
                  </span>
                </div>
                {filas.map((x, i) => (
                  <Linea key={`${esc.key}-${x.gl_code}-${i}`} x={x} importeBase={p.loan_amount} sucursal={p.branch} />
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
              <span className="uppercase tracking-wide">
                &minus; LO commission
                <span className="ml-1.5 font-normal normal-case tracking-normal text-slate-400">
                  from Compensafe
                </span>
              </span>
              <span className="font-mono tabular-nums text-rose-700">
                {p.commission == null
                  ? <span className="text-slate-400" title="This loan does not cross with Compensafe. Not the same as a zero commission.">not known</span>
                  : <>
                      {usdExacto(-p.commission)}
                      <span className="ml-1 font-normal opacity-70">{bps(-p.commission, p.loan_amount)}</span>
                    </>}
              </span>
            </div>
          )}
        </div>

        {/*
          * ⚠ LA SECCION DE LA 700 VA DESPUES DEL TOTAL EN LA LECTURA, pero antes
          * en el marcado porque el banner esta pegado al fondo de la tarjeta.
          * Va separada y en gris para que no parezca que participa en la resta,
          * y la etiqueta dice UNA VEZ que no entra -- no en cada fila.
          */}
        {p.elsewhere && p.elsewhere.some((s) => s.lineas.length > 0) && (
          <div className="mt-2 border-t-2 border-slate-200 px-3 pt-2">
            <p className="text-[9px] font-bold uppercase tracking-wide text-slate-400">
              Not part of this branch&rsquo;s contribution
            </p>
            {p.elsewhere.map((s) => s.lineas.length === 0 ? null : (
              <Fragment key={s.label}>
                <div className="mt-1 flex items-center justify-between px-3 text-[10px] font-semibold text-slate-500">
                  <span>{s.label}</span>
                  <span className="font-mono tabular-nums">
                    {usdExacto(s.lineas.reduce((a, x) => a + x.amount, 0))}
                  </span>
                </div>
                <div className="opacity-60">
                  {s.lineas.map((x, i) => (
                    <Linea key={`${s.label}-${i}`} x={x} importeBase={p.loan_amount} sucursal={p.branch} />
                  ))}
                </div>
              </Fragment>
            ))}
          </div>
        )}
      </div>

      {/* ── El banner del total, pegado al fondo ──────────────────────────── */}
      <div
        className={`mt-2 flex items-center justify-between rounded-b-2xl p-3 text-xs font-bold shadow-xs ${
          perdida ? "border-t border-rose-200 bg-rose-100 text-rose-900" : "bg-[#001A40] text-white"
        }`}
      >
        <span>{p.total.label}</span>
        <span>
          <span className={`font-mono font-bold tabular-nums ${perdida ? "text-rose-700" : "text-emerald-300"}`}>
            {p.total.value == null ? "—" : usdExacto(p.total.value)}
          </span>
          <span className={`ml-1.5 font-mono text-[11px] ${perdida ? "text-rose-800" : "text-emerald-400"}`}>
            {p.total.value == null ? "— bps" : bps(p.total.value, p.loan_amount)}
          </span>
        </span>
      </div>
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
