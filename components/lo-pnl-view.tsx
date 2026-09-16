"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, AlertTriangle, Info, HelpCircle, X } from "lucide-react";
import { closePeriod, MONTH_NAMES_IN_ORDER } from "@/lib/close-period";
import type { LoPnlResult, OfficerBlock, OfficerGroup, LoanRow, LoanLine, PayrollRow } from "@/app/api/lo-pnl/route";

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * P&L POR LOAN OFFICER
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * La pantalla contesta tres preguntas, en este orden: CUANTO PRODUCE esta
 * persona, CUANTO SE LLEVA, y CUANTO CUESTA. Todo lo demas esta subordinado a
 * esas tres.
 *
 * ⚠ Y ESO ES UNA DECISION DE DISENO, no una casualidad del layout. Este modulo
 * arrastra SEIS salvedades --el total no resta la comision, dos personas cobran
 * comision fuera de la nomina, hay nomina de atribucion menos fiable, once loan
 * officers no tienen nomina localizada, dos nombres son la misma persona, y el
 * solape vive en cuatro cuentas--. Puestas todas al mismo nivel que las cifras,
 * la pantalla se convierte en un tablero de advertencias y el numero que se
 * viene a ver se pierde entre ellas.
 *
 * Por eso: la tabla manda, cada salvedad aparece SOLO en la fila que afecta y
 * como una marca pequeña, y el detalle largo vive en una nota plegada al final
 * que nadie tiene que abrir para leer la cifra.
 */

// ─── Formato ──────────────────────────────────────────────────────────────────

function usd(n: number | null | undefined, opts: { signo?: boolean } = {}) {
  if (n == null) return "—";
  const s = new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: 0,
  }).format(Math.abs(n));
  return n < 0 ? `(${s})` : opts.signo ? `+${s}` : s;
}

function usdExacto(n: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", minimumFractionDigits: 2,
  }).format(n);
}

/** Verde si gana, rojo si pierde. El cero no es ninguna de las dos cosas. */
function colorNeto(n: number) {
  if (n > 0) return "text-emerald-700";
  if (n < 0) return "text-red-600";
  return "text-gray-500";
}

// ─── Marcas ───────────────────────────────────────────────────────────────────

/**
 * Una salvedad, pegada a la fila que afecta.
 *
 * Deliberadamente pequeña y en gris: tiene que poder ignorarse de un vistazo y
 * estar ahi cuando alguien pregunte por ese numero concreto. El texto completo
 * va en el `title`, no en la pantalla.
 */
function Marca({ children, title, tono = "gris" }: {
  children: React.ReactNode; title: string; tono?: "gris" | "ambar";
}) {
  const clases = tono === "ambar"
    ? "border-amber-200 bg-amber-50 text-amber-700"
    : "border-slate-200 bg-slate-50 text-slate-500";
  return (
    <span title={title}
      className={`ml-1.5 inline-flex items-center rounded border px-1 py-0.5 text-[9px] font-medium ${clases}`}>
      {children}
    </span>
  );
}

// ─── Detalle de una persona ───────────────────────────────────────────────────

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * EL DESGLOSE DE UN PRESTAMO, CUENTA A CUENTA
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ SIN AGRUPAR POR CUENTA, Y ES LA DECISION QUE DA SENTIDO AL BLOQUE. Medido
 * sobre los 736 prestamos con apuntes: agrupar por gl_code + sucursal taparia
 * 590.857,86 de movimiento en 727 grupos, y en 317 de ellos --209 prestamos--
 * lo tapado son filas que se compensan.
 *
 * El caso que lo motiva, 710002042266: la fila resumen dice "Margin 7.272,43 /
 * Other 1.130,70" y dentro hay un par de 9.602,39 que se anula entero --41305
 * LO Margin contra 41200 Discount Income--. Colapsado, ese movimiento no
 * existe. Y agrupando por cuenta desaparecerian ademas otros dos pares dentro
 * de la MISMA cuenta: 41205 (+389,00 y -333,00) y 41309 (+448,50 y -280,31).
 *
 * ⚠ CERRADO POR DEFECTO. El panel ya lleva tres modulos; catorce lineas
 * abiertas en cada uno de 24 prestamos empujarian la nomina y la cuenta fuera
 * de la vista.
 */
/**
 * ─────────────────────────────────────────────────────────────────────────────
 * LA ESCALERA: LOS ESCALONES EN QUE SE LEE UN PRESTAMO
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *     Branch gross revenue      lo que dejo, ANTES de pagar al loan officer
 *   ± Direct production costs   tasacion, informe de credito, verificacion
 *   ± Other booked to the loan  lo que no es ninguno de los dos (casi nunca)
 *   − LO commission             lo que cobra el loan officer
 *   = Total contribution
 *
 * ⚠ LOS COSTES DIRECTOS SUMAN, Y POR ESO LA ETIQUETA NO DICE "MENOS". Salen en
 * positivo --+416,70 en el prestamo 710002042266-- porque se le cobran al
 * prestatario y vuelven a la sucursal. Un "− Direct production costs" con un
 * numero positivo al lado diria lo contrario de lo que pasa. El signo, tal cual.
 */
const ESCALONES = [
  {
    key: "revenue" as const,
    label: "Branch gross revenue",
    hint: "What the loan left before paying the loan officer.",
    grupo: "Revenue",
  },
  {
    key: "direct" as const,
    label: "Direct production costs",
    hint: "Appraisal, credit report, verification. Shown with its own sign — these usually ADD, because they are charged to the borrower and come back to the branch.",
    grupo: "Direct Production Costs",
  },
  {
    key: "other" as const,
    label: "Other booked to the loan",
    hint: "Anything booked against the loan that is neither revenue nor a direct production cost. Almost always zero.",
    grupo: null,
  },
];

/** A que escalon pertenece una linea. El mismo reparto que hace la ruta. */
function escalonDe(categoria6: string | null | undefined) {
  if (categoria6 === "Revenue") return "revenue" as const;
  if (categoria6 === "Direct Production Costs") return "direct" as const;
  return "other" as const;
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * EL DESGLOSE DE UN PRESTAMO, CUENTA A CUENTA Y POR ESCALON
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ SIN AGRUPAR POR CUENTA, Y ES LA DECISION QUE DA SENTIDO AL BLOQUE. Medido
 * sobre los 736 prestamos con apuntes: agrupar por gl_code + sucursal taparia
 * 590.857,86 de movimiento en 727 grupos, y en 317 de ellos --209 prestamos--
 * lo tapado son filas que se compensan.
 *
 * El caso que lo motiva, 710002042266: dentro de su Branch gross revenue hay un
 * par de 9.602,39 que se anula entero --41305 LO Margin contra 41200 Discount
 * Income-- y los dos van en el MISMO escalon, para que se vea anularse.
 * Agrupando por cuenta desaparecerian ademas otros dos pares dentro de la misma
 * cuenta: 41205 (+389,00 y −333,00) y 41309 (+448,50 y −280,31).
 *
 * ⚠ CERRADO POR DEFECTO. El panel ya lleva tres modulos; catorce lineas
 * abiertas en cada uno de 24 prestamos empujarian la nomina y la cuenta fuera
 * de la vista.
 */
function DesglosePrestamo({ l }: { l: LoanRow }) {
  // Por importe absoluto descendente dentro de cada escalon: lo que mas mueve,
  // primero. El orden del P&L de origen no dice nada, y el alfabetico por cuenta
  // esconde el tamaño.
  const porEscalon = new Map<string, LoanLine[]>();
  const fuera: LoanLine[] = [];
  for (const x of l.lines) {
    // Fuera de su sucursal no cae en ningun escalon: se enseña aparte y no suma.
    if (!x.in_branch) { fuera.push(x); continue; }
    const k = escalonDe(x.category_6);
    porEscalon.set(k, [...(porEscalon.get(k) ?? []), x]);
  }
  for (const v of porEscalon.values()) v.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  fuera.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  const subtotal = (k: string) => (porEscalon.get(k) ?? []).reduce((s, x) => s + x.amount, 0);

  return (
    <tr className="bg-slate-50">
      <td colSpan={7} className="border-b border-gray-200 px-3 py-2">
        <table className="w-full text-[11px]">
          <tbody>
            {ESCALONES.map((esc) => {
              const filas = porEscalon.get(esc.key) ?? [];
              // El escalon "other" solo aparece cuando tiene algo: un renglon
              // permanente a cero en 481 de 482 prestamos es ruido.
              if (filas.length === 0) return null;
              return (
                <Fragment key={esc.key}>
                  <tr className="border-t-2 border-gray-300 bg-white/70">
                    <td className="px-2 py-1 font-semibold uppercase tracking-wide text-gray-600" colSpan={4}>
                      <span title={esc.hint} className="cursor-help">{esc.label}</span>
                      {esc.key === "revenue" && l.branch && (
                        <span className="ml-1.5 font-normal normal-case tracking-normal text-gray-400">
                          branch {l.branch}
                        </span>
                      )}
                    </td>
                    <td className={`px-2 py-1 text-right font-mono tabular-nums font-semibold ${
                      colorNeto(subtotal(esc.key))
                    }`}>
                      {usdExacto(subtotal(esc.key))}
                    </td>
                  </tr>
                  {filas.map((x, i) => {
                    /*
                     * ⚠ LA SUCURSAL DEL APUNTE SE DISTINGUE CUANDO NO ES LA DEL
                     * PRESTAMO, PERO EN NEUTRO Y NO EN AMBAR.
                     *
                     * Medido: 1.999 de 5.536 lineas --el 36,1%-- se contabilizan
                     * en otra sucursal. Parte del margen va a la 700 por diseño,
                     * asi que en ambar un tercio de cada desglose pareceria un
                     * problema y la marca dejaria de significar nada. Es
                     * informacion, y se viste como informacion.
                     *
                     * Es el mismo error del que ya avisa
                     * lib/loan-detail-accounts.ts: comparar contra la sucursal
                     * del prestamo marcaba 308 de 374.
                     */
                    const otraSucursal = !!x.branch && !!l.branch && x.branch !== l.branch;
                    return (
                      <tr key={`${esc.key}-${i}`} className="border-t border-gray-200/70">
                        <td className="px-2 py-1 pl-5 font-mono text-gray-600">{x.gl_code ?? "—"}</td>
                        <td className="px-2 py-1 text-gray-700" title={x.check_description ?? undefined}>
                          {x.gl_name ?? "—"}
                        </td>
                        <td className="px-2 py-1 text-gray-500">{x.category_7 ?? "—"}</td>
                        <td className="px-2 py-1">
                          <span
                            className={otraSucursal
                              ? "rounded border border-slate-300 bg-white px-1 font-mono text-slate-600"
                              : "font-mono text-gray-500"}
                            title={otraSucursal
                              ? `Booked in branch ${x.branch}, while the loan is branch ${l.branch}. Common and not an error: part of the margin is booked in 700 by design.`
                              : undefined}
                          >
                            {x.branch ?? "—"}
                          </span>
                        </td>
                        {/*
                          * Al centimo, no redondeado como la tabla de fuera:
                          * este desglose existe para poder cuadrar contra la
                          * contabilidad, y con dolares enteros no cuadra.
                          */}
                        <td className={`px-2 py-1 text-right font-mono tabular-nums ${
                          x.amount < 0 ? "text-red-600" : "text-gray-700"
                        }`}>
                          {usdExacto(x.amount)}
                        </td>
                      </tr>
                    );
                  })}
                </Fragment>
              );
            })}

            {/*
              * ─────────────────────────────────────────────────────────────
              * LO QUE NO SE QUEDA ESTA SUCURSAL: SE VE, PERO NO SUMA
              * ─────────────────────────────────────────────────────────────
              *
              * ⚠ ES REVENUE REAL DEL PRESTAMO, y esconderlo seria mentir en la
              * direccion mas facil de creerse: la escalera cuadraria sola y
              * nadie sabria que falta nada. En la division son 1.280.161,00 --
              * el 22,8% de lo que producen los cierres-- casi todo margen de
              * division contabilizado en la 700.
              *
              * Va DESPUES de los escalones y ANTES de la comision, con su
              * subtotal y en gris, para que se lea como lo que es: dinero del
              * prestamo que se fue a otro sitio.
              */}
            {fuera.length > 0 && (
              <>
                <tr className="border-t-2 border-gray-300 bg-white/70">
                  <td className="px-2 py-1 font-semibold uppercase tracking-wide text-gray-400" colSpan={4}>
                    Booked elsewhere
                    <span className="ml-1.5 font-normal normal-case tracking-normal text-gray-400">
                      not counted here — real revenue on this loan that another branch keeps
                    </span>
                  </td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums font-semibold text-gray-400">
                    {usdExacto(fuera.reduce((s, x) => s + x.amount, 0))}
                  </td>
                </tr>
                {fuera.map((x, i) => (
                  <tr key={`fuera-${i}`} className="border-t border-gray-200/70 text-gray-400">
                    <td className="px-2 py-1 pl-5 font-mono">{x.gl_code ?? "—"}</td>
                    <td className="px-2 py-1" title={x.check_description ?? undefined}>{x.gl_name ?? "—"}</td>
                    <td className="px-2 py-1">{x.category_7 ?? "—"}</td>
                    <td className="px-2 py-1">
                      <span className="rounded border border-slate-300 bg-white px-1 font-mono text-slate-600"
                            title={`Booked in branch ${x.branch}, while the loan is branch ${l.branch}.`}>
                        {x.branch ?? "—"}
                      </span>
                    </td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums">{usdExacto(x.amount)}</td>
                  </tr>
                ))}
              </>
            )}

            {/*
              * ⚠ LA COMISION ES UN ESCALON SIN CUENTAS, Y HAY QUE DECIRLO. No
              * sale del P&L sino de comp.loan_commission, asi que no tiene
              * gl_code que enseñar y no se puede cuadrar contra el libro mayor
              * como las de arriba. Un escalon con la misma pinta que los otros
              * y sin lineas se leeria como un fallo de carga.
              */}
            <tr className="border-t-2 border-gray-300 bg-white/70">
              <td className="px-2 py-1 font-semibold uppercase tracking-wide text-gray-600" colSpan={4}>
                LO commission
                <span className="ml-1.5 font-normal normal-case tracking-normal text-gray-400">
                  from Compensafe — not a P&amp;L account
                </span>
              </td>
              <td className="px-2 py-1 text-right font-mono tabular-nums font-semibold text-red-600">
                {l.commission == null
                  ? <span className="text-gray-400" title="This loan does not cross with Compensafe. Not the same as a zero commission.">not known</span>
                  : usdExacto(-l.commission)}
              </td>
            </tr>
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-gray-400 font-semibold text-gray-800">
              <td className="px-2 py-1 uppercase tracking-wide" colSpan={4}>= Total contribution</td>
              <td className={`px-2 py-1 text-right font-mono tabular-nums ${colorNeto(l.contribution ?? 0)}`}>
                {l.contribution == null ? "—" : usdExacto(l.contribution)}
              </td>
            </tr>
          </tfoot>
        </table>
      </td>
    </tr>
  );
}

function BloquePrestamos({ loans }: { loans: LoanRow[] }) {
  const [abierto, setAbierto] = useState<string | null>(null);

  if (loans.length === 0) {
    return (
      <div className="px-4 py-3 text-xs text-gray-400 italic">
        No closings in this period.
      </div>
    );
  }
  const sum = (f: (l: LoanRow) => number) => loans.reduce((s, l) => s + f(l), 0);
  const hayOtros = loans.some((l) => l.otherBooked !== 0);

  return (
    <div className="overflow-auto max-h-80">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-gray-50">
          <tr className="text-left text-gray-500 border-b border-gray-200">
            {/*
              * ⚠ LAS COLUMNAS SON LOS ESCALONES, LAS MISMAS QUE LA FILA DE LA
              * PERSONA Y LAS MISMAS QUE EL DESGLOSE DE DENTRO. Antes decian
              * "Margin earned / Other loan costs / What it left", que es un
              * reparto distinto del que usa el total de arriba: el prestamo se
              * leia de una forma y la persona de otra, sobre los mismos datos.
              */}
            <th className="px-3 py-1.5 font-medium">Loan</th>
            <th className="px-3 py-1.5 font-medium">Closed</th>
            <th className="px-3 py-1.5 font-medium text-right">Loan amount</th>
            <th className="px-3 py-1.5 font-medium text-right" title="What the loan left before paying the loan officer.">
              Gross revenue
            </th>
            <th className="px-3 py-1.5 font-medium text-right" title="Appraisal, credit report, verification. Shown with its own sign — these usually ADD, because they are charged to the borrower and come back to the branch.">
              Direct costs
            </th>
            <th className="px-3 py-1.5 font-medium text-right" title="Paid to the loan officer for this loan, from Compensafe.">
              LO commission
            </th>
            <th className="px-3 py-1.5 font-medium text-right" title="Gross revenue plus direct costs, minus the commission. What this loan left the branch after paying the loan officer.">
              Contribution
            </th>
          </tr>
        </thead>
        <tbody>
          {loans.map((l) => {
            const abre = abierto === l.loan_number;
            return (
            <Fragment key={l.loan_number}>
            <tr
              onClick={() => setAbierto(abre ? null : l.loan_number)}
              className={`cursor-pointer border-b border-gray-100 hover:bg-gray-50 ${abre ? "bg-gray-50" : ""}`}>
              <td className="px-3 py-1 font-mono text-gray-700">
                <span className="inline-flex items-center">
                  <ChevronRight size={11}
                    className={`mr-1 shrink-0 transition-transform ${abre ? "rotate-90 text-blue-600" : "text-gray-400"}`} />
                  {l.loan_number}
                </span>
              </td>
              <td className="px-3 py-1 text-gray-500">{l.month} {l.year}</td>
              <td className="px-3 py-1 text-right text-gray-600">{usd(l.loan_amount)}</td>
              <td className="px-3 py-1 text-right">
                {usd(l.grossRevenue)}
                {/*
                  * Lo contabilizado en otra sucursal, pegado a la columna que
                  * lo echa de menos. Sin esto, un prestamo con casi todo su
                  * margen en la 700 enseña un gross revenue pequeño y no hay
                  * nada en la fila que explique por que.
                  */}
                {l.bookedElsewhere !== 0 && (
                  <span className="ml-1 text-[10px] text-gray-400"
                        title="Booked on this loan but in another branch, so it is not counted here. Open the loan to see which accounts.">
                    {usd(l.bookedElsewhere, { signo: true })} elsewhere
                  </span>
                )}
              </td>
              <td className="px-3 py-1 text-right">
                {usd(l.directCosts)}
                {/*
                  * Lo que no cae en ninguno de los dos grupos viaja pegado a los
                  * costes directos y DICHO, no sumado en silencio. Es un solo
                  * prestamo en toda la division --el 700002013844, con -8.721,60
                  * de Office Expense-- y esconderlo por raro seria justo el
                  * error que el desglose existe para no cometer.
                  */}
                {l.otherBooked !== 0 && (
                  <span className="ml-1 text-[10px] text-slate-500"
                        title="Booked against this loan but neither revenue nor a direct production cost. It is inside the contribution.">
                    {usd(l.otherBooked, { signo: true })} other
                  </span>
                )}
              </td>
              <td className="px-3 py-1 text-right text-gray-500">
                {/*
                  * Null no es cero: el prestamo no cruzo con Compensafe. Un cero
                  * aqui diria "no cobro por el", que es otra cosa.
                  */}
                {l.commission == null
                  ? <span title="This loan does not cross with Compensafe. Not the same as a zero commission."
                          className="text-gray-300">—</span>
                  : usd(-l.commission)}
              </td>
              <td className={`px-3 py-1 text-right font-mono tabular-nums font-medium ${colorNeto(l.contribution ?? 0)}`}>
                {l.contribution == null
                  ? <span className="text-gray-300" title="Without a known commission there is no contribution to compute. Showing the gross here would say nobody was paid.">—</span>
                  : usd(l.contribution)}
              </td>
            </tr>
            {abre && <DesglosePrestamo l={l} />}
            </Fragment>
            );
          })}
        </tbody>
        {/*
          * ⚠ LA FILA DE TOTALES ES LO QUE ATA ESTE BLOQUE A LA FILA DE FUERA.
          * Sin ella hay que sumar 24 prestamos a mano para comprobar de donde
          * sale la contribucion de la persona, y entonces el detalle no
          * demuestra nada: solo acompaña.
          *
          * La comision se suma SOLO de los prestamos que cruzaron. Los que no
          * cruzan valen null, no cero, y cuantos son se dice en la tarjeta.
          */}
        <tfoot className="sticky bottom-0 bg-gray-50">
          <tr className="border-t-2 border-gray-300 font-semibold text-gray-700">
            <td className="px-3 py-1.5" colSpan={2}>
              {loans.length} loan{loans.length === 1 ? "" : "s"}
            </td>
            <td className="px-3 py-1.5 text-right">{usd(sum((l) => l.loan_amount ?? 0))}</td>
            <td className="px-3 py-1.5 text-right">
              {usd(sum((l) => l.grossRevenue))}
              {sum((l) => l.bookedElsewhere) !== 0 && (
                <span className="ml-1 text-[10px] font-normal text-gray-400">
                  {usd(sum((l) => l.bookedElsewhere), { signo: true })} elsewhere
                </span>
              )}
            </td>
            <td className="px-3 py-1.5 text-right">
              {usd(sum((l) => l.directCosts))}
              {hayOtros && (
                <span className="ml-1 text-[10px] font-normal text-slate-500">
                  {usd(sum((l) => l.otherBooked), { signo: true })} other
                </span>
              )}
            </td>
            <td className="px-3 py-1.5 text-right">{usd(-sum((l) => l.commission ?? 0))}</td>
            <td className={`px-3 py-1.5 text-right font-mono tabular-nums ${colorNeto(sum((l) => l.contribution ?? 0))}`}>
              {usd(sum((l) => l.contribution ?? 0))}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function BloqueNomina({ rows, fragiles }: { rows: PayrollRow[]; fragiles: PayrollRow[] }) {
  if (rows.length === 0 && fragiles.length === 0) {
    return (
      <div className="px-4 py-3 text-xs text-gray-400 italic">
        No payroll located for this person in this period.
      </div>
    );
  }
  const porCuenta = new Map<string, { nombre: string; total: number; filas: number }>();
  for (const r of rows) {
    const k = r.gl_code ?? "—";
    const e = porCuenta.get(k) ?? { nombre: r.gl_name ?? "", total: 0, filas: 0 };
    e.total += r.amount; e.filas++;
    porCuenta.set(k, e);
  }
  const fragilTotal = fragiles.reduce((s, r) => s + r.amount, 0);

  return (
    <div className="px-3 py-2">
      <table className="w-full text-xs">
        <tbody>
          {[...porCuenta.entries()].sort((a, b) => a[1].total - b[1].total).map(([gl, v]) => (
            <tr key={gl} className="border-b border-gray-100">
              <td className="px-2 py-1 font-mono text-gray-500 w-16">{gl}</td>
              <td className="px-2 py-1 text-gray-600">{v.nombre}</td>
              <td className="px-2 py-1 text-right text-gray-400 w-16">{v.filas}</td>
              <td className="px-2 py-1 text-right font-medium">{usdExacto(v.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {fragiles.length > 0 && (
        /*
         * Fuera del total y dicho. Si no se enseñara, estas personas caerian en
         * "no payroll located", y eso seria FALSO -- y falso de la peor manera,
         * porque se leeria como un hallazgo.
         */
        <div className="mt-2 rounded border border-slate-200 bg-slate-50 px-2 py-1.5">
          <div className="text-[10px] font-medium text-slate-500">
            Not in the total — less reliable attribution
          </div>
          <div className="mt-0.5 text-[10px] text-slate-500">
            {fragiles.length} row{fragiles.length !== 1 ? "s" : ""}, {usdExacto(fragilTotal)}.
            Descriptions like “ZOOMPLUS-NAME” or “SALESFORCE USER FOR NAME” carry the name in a
            shape that cannot be parsed as reliably as “SURNAME, NAME”.
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Las cuatro secciones, en el orden en que se leen.
 *
 * ⚠ "Role unknown" VA EL ULTIMO Y NO ES RESIDUAL: son 22 personas con 76
 * cierres y 446.928 de neto. Pero su problema es de DATOS --no estan en el
 * roster de RRHH-- y no de negocio, asi que mezclarlo arriba confunde sobre que
 * se esta mirando. Su cabecera dice por que estan ahi.
 */
const SECCIONES: { key: OfficerGroup; label: string; hint: string }[] = [
  {
    key: "producer",
    label: "Producers",
    hint: "They close loans. This is the group the module is about: does this person pay for themselves?",
  },
  {
    key: "support",
    label: "Support",
    hint: "Assistants, processors and support staff. They have a real cost and close no loans — that is their job, not a finding.",
  },
  {
    key: "nppm",
    label: "NPPM",
    hint: "Non-producing production managers tied to realtors. A different figure and a different question.",
  },
  {
    key: "unknown",
    label: "Role unknown",
    hint: "Not found in the HR roster, so there is no role to show. Former staff and people who were never in HR.",
  },
];

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * EL DETALLE DE UNA PERSONA, EN UN PANEL LATERAL
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ ANTES ERA UNA FILA QUE SE ABRIA DENTRO DE LA TABLA, y por eso se cambia:
 * abrir a Gian Laino metia 24 prestamos y 30 lineas de nomina EN MEDIO de la
 * lista, empujando a los demas media pantalla hacia abajo. Comparar dos
 * personas exigia cerrar la primera, y la fila que se estaba mirando se movia
 * bajo el cursor al hacerlo.
 *
 * El panel deja la tabla quieta: se abre al lado, se compara con lo que sigue
 * viendose detras, y se cierra sin que nada salte.
 *
 * ⚠ z-[60]/z-[70] Y NO z-40/z-50 A PROPOSITO: esta vista vive TAMBIEN dentro
 * del modal de P&L por sucursal, que ocupa esos dos niveles. Con los mismos, el
 * panel se abriria DEBAJO del modal que lo contiene -- invisible, y sin que
 * nada pareciera roto.
 */
function PanelDetalle({ o, onClose }: { o: OfficerBlock; onClose: () => void }) {
  // Escape cierra. Un panel que solo se cierra con la X se queda abierto en
  // cuanto alguien lo intenta por el camino de siempre.
  useEffect(() => {
    const alPulsar = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", alPulsar);
    return () => window.removeEventListener("keydown", alPulsar);
  }, [onClose]);

  const nominaPos = -o.block2Total;
  const localizada = o.payrollStatus !== "not_located";
  // Comision menos nomina. Informativo: son dos calendarios y no tienen por
  // que cuadrar. Ver la linea que lo dice dentro de la tarjeta.
  const diferencia = o.commission - nominaPos;

  return (
    <>
      <div className="fixed inset-0 z-[60] bg-slate-900/25" onClick={onClose} />
      <aside
        role="dialog"
        aria-label={`Detail for ${o.name}`}
        className="fixed inset-y-0 right-0 z-[70] flex h-full w-full max-w-3xl flex-col border-l border-slate-200 bg-white shadow-2xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-gray-200 px-5 py-3">
          <div>
            <h3 className="text-sm font-semibold text-[#001A40]">{o.name}</h3>
            <p className="mt-0.5 text-[11px] text-gray-500">
              {o.position ?? "Role not in the HR roster"}
              {o.area ? ` · ${o.area}` : ""}
              {o.branch ? ` · branch ${o.branch}` : ""}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* ── A · Lo que produjo, prestamo a prestamo ───────────────────── */}
          <section>
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              What they produced · {o.loanCount} loan{o.loanCount !== 1 ? "s" : ""}
            </h4>
            {/*
              * ⚠ EL CONTADOR DICE LAS DOS COSAS. Uno que solo pusiera "2
              * pendientes" esconderia que ya hay coste apuntado, y el lector
              * supondria que no hay nada hasta que cargue el mes.
              */}
            {o.loansPendingPl > 0 && (
              <p className="mt-1 text-[11px] text-amber-700">
                {o.loansPendingPl} closing{o.loansPendingPl === 1 ? "" : "s"} with no P&amp;L loaded
                for their month — {usdExacto(Math.abs(o.pendingPlBooked))} of origination cost is
                already booked, the margin is not. Left out of the figures below.
              </p>
            )}
            <div className="mt-2 rounded-lg border border-gray-200 overflow-hidden">
              <BloquePrestamos loans={o.loans} />
            </div>
          </section>

          {/* ── B · Lo que costo, por cuenta ──────────────────────────────── */}
          <section>
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              What they cost · payroll by account
            </h4>
            <p className="mt-1 text-[11px] text-gray-500">
              Not tied to any loan. This is the whole payroll the P&amp;L records for this person in
              the selected period.
            </p>
            <div className="mt-2 rounded-lg border border-gray-200 overflow-hidden">
              <BloqueNomina rows={o.payroll} fragiles={o.payrollFragile} />
            </div>
          </section>

          {/* ── C · La escalera, y debajo la nomina que no cuelga de nada ──── */}
          <section>
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              The account
            </h4>
            <div className="mt-2 rounded-xl bg-[#001A40] px-5 py-4 text-white">
              {/*
                * ⚠ LOS COSTES DIRECTOS SUMAN Y LA ETIQUETA NO DICE "MENOS".
                * Salen en positivo porque se le cobran al prestatario y vuelven
                * a la sucursal; un "−" delante de un numero positivo diria lo
                * contrario de lo que pasa. Por eso el signo va pegado al
                * importe y no a la etiqueta, en este escalon y solo en este.
                */}
              <dl className="space-y-1.5 text-xs">
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-white/70">Branch gross revenue</dt>
                  <dd className="font-mono tabular-nums">{usdExacto(o.block1Revenue)}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-white/70">
                    Direct production costs
                    <span className="ml-1.5 text-[10px] text-white/40">appraisal, credit, verification</span>
                  </dt>
                  <dd className="font-mono tabular-nums">{usdExacto(o.block1DirectCosts)}</dd>
                </div>
                {o.block1OtherBooked !== 0 && (
                  <div className="flex items-baseline justify-between gap-4">
                    <dt className="text-white/70">
                      Other booked to their loans
                      <span className="ml-1.5 text-[10px] text-white/40">neither of the two above</span>
                    </dt>
                    <dd className="font-mono tabular-nums">{usdExacto(o.block1OtherBooked)}</dd>
                  </div>
                )}
                {/*
                  * ⚠ LO QUE SE VA A OTRA SUCURSAL, DICHO Y NO SUMADO. Es el
                  * 22,8% de lo que producen los cierres de la division
                  * --1.280.161,00-- y casi todo es margen de division en la
                  * 700. Sin esta linea, la escalera de alguien que produce
                  * mucho en la 700 sale pequeña y nada en la tarjeta explica
                  * por que.
                  */}
                {o.block1Elsewhere !== 0 && (
                  <div className="flex items-baseline justify-between gap-4 text-white/40">
                    <dt>
                      Booked elsewhere
                      <span className="ml-1.5 text-[10px]">not counted — another branch keeps it</span>
                    </dt>
                    <dd className="font-mono tabular-nums">{usdExacto(o.block1Elsewhere)}</dd>
                  </div>
                )}
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-white/70">− LO commission</dt>
                  <dd className="font-mono tabular-nums">{usdExacto(-o.commission)}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-4 border-t border-white/20 pt-2">
                  <dt className="font-semibold">= Total contribution</dt>
                  <dd className={`font-mono tabular-nums text-base font-semibold ${
                    o.contribution > 0 ? "text-emerald-300" : o.contribution < 0 ? "text-red-300" : "text-white/70"
                  }`}>
                    {usdExacto(o.contribution)}
                  </dd>
                </div>
              </dl>

              {/*
                * ─────────────────────────────────────────────────────────────
                * ⚠ LA SEGUNDA CUENTA NO ES LA CONTINUACION DE LA PRIMERA
                * ─────────────────────────────────────────────────────────────
                *
                * Encadenarlas --restarle la nomina a Total contribution-- es el
                * error que mas caro sale en esta pantalla, porque el resultado
                * parece razonable: la comision se PAGA POR LA NOMINA, asi que
                * restarla en la escalera Y ADEMAS restar la nomina entera resta
                * el mismo dinero dos veces.
                *
                * Medido en la division: 1.163.656,81 de comision dentro de una
                * nomina de 5.362.891,98 -- el 21,7% del coste, contado otra vez.
                * En Gian Laino serian 91.440,93 que lo dejarian pareciendo casi
                * cien mil peor de lo que es.
                *
                * Por eso el Net de abajo arranca otra vez de lo PRODUCIDO, no de
                * la contribucion, y la linea que las separa lo dice.
                */}
              <div className="mt-4 border-t-2 border-white/25 pt-3">
                <p className="text-[10px] uppercase tracking-wide text-white/40">
                  Does this person pay for themselves — a separate question
                </p>
                <dl className="mt-2 space-y-1.5 text-xs">
                  <div className="flex items-baseline justify-between gap-4">
                    <dt className="text-white/70">
                      Produced
                      <span className="ml-1.5 text-[10px] text-white/40">what their own branch kept, before commission</span>
                    </dt>
                    <dd className="font-mono tabular-nums">{usdExacto(o.produced)}</dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-4">
                    <dt className="text-white/70">
                      − Payroll paid
                      <span className="ml-1.5 text-[10px] text-white/40">salary, taxes, insurance — and the commission</span>
                    </dt>
                    <dd className="font-mono tabular-nums">
                      {localizada ? usdExacto(nominaPos) : (
                        <span className="text-amber-300" title="No payroll row anywhere in the P&L carries this name. This is an absence, not a zero.">
                          not located
                        </span>
                      )}
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-4 border-t border-white/20 pt-2">
                    <dt className="font-semibold">= Net</dt>
                    <dd className={`font-mono tabular-nums text-base font-semibold ${
                      o.total > 0 ? "text-emerald-300" : o.total < 0 ? "text-red-300" : "text-white/70"
                    }`}>
                      {usdExacto(o.total)}
                    </dd>
                  </div>
                </dl>
              </div>

              <div className="mt-3 space-y-1 border-t border-white/15 pt-3 text-[11px] text-white/60">
                <p className="leading-relaxed">
                  <span className="text-white/80">The two totals do not chain.</span> The commission
                  is subtracted in the ladder above and is <span className="text-white/80">also</span>{" "}
                  inside the payroll below — it is paid through payroll. Subtracting it from the
                  contribution as well would count the same money twice.
                </p>
                <div className="flex items-baseline justify-between gap-4 pt-1.5">
                  <span>Difference: commission vs payroll paid</span>
                  <span className="font-mono tabular-nums">
                    {localizada ? usdExacto(diferencia) : "—"}
                  </span>
                </div>
                <p className="leading-relaxed">
                  They are two calendars and are not meant to match: Compensafe groups commission by{" "}
                  <span className="text-white/80">closing date</span> and the P&amp;L records payroll
                  by <span className="text-white/80">payment date</span>, so a loan closed at the end
                  of a month is paid in the next period.
                </p>
                {o.loansWithoutCommission > 0 && (
                  <p className="leading-relaxed">
                    {o.loansWithoutCommission} of these loans do not cross with Compensafe, so no
                    commission is known for them. Not the same as a zero — and the contribution above
                    leaves them out rather than counting them as free.
                  </p>
                )}
              </div>
            </div>
          </section>
        </div>
      </aside>
    </>
  );
}

// ─── La pantalla ──────────────────────────────────────────────────────────────

/**
 * La tabla de P&L por Loan Officer, en los DOS sitios donde vive.
 *
 * Como pantalla propia --/lo-pnl-- y como pestaña del modal de detalle de
 * prestamos, donde enseña los loan officers de ESA sucursal. Un solo sitio y no
 * dos: dos copias de esta tabla serian dos definiciones de "cuanto produce esta
 * persona" separandose sin que nada falle, que es el patron que este modulo
 * lleva toda su vida desmontando.
 *
 * @param branch  La sucursal del modal. Null en la pantalla propia.
 */
export function LoPnlView({ branch = null }: { branch?: string | null }) {
  const def = useMemo(() => closePeriod(), []);
  const [all, setAll] = useState(false);
  const [month, setMonth] = useState(def.month);
  const [year, setYear] = useState(String(def.year));
  const [data, setData] = useState<LoPnlResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [abierto, setAbierto] = useState<string | null>(null);
  const [notaAbierta, setNotaAbierta] = useState(false);
  const [avisosAbiertos, setAvisosAbiertos] = useState(false);

  /*
   * ─────────────────────────────────────────────────────────────────────────
   * LA ALTURA DE LOS CONTROLES SE MIDE, NO SE ESCRIBE
   * ─────────────────────────────────────────────────────────────────────────
   *
   * La cabecera de la tabla se fija JUSTO DEBAJO de la barra de controles, y
   * para eso necesita su altura. Escrita a mano seria un numero que se queda
   * viejo al primer cambio de texto: la barra mide distinto dentro del modal
   * de sucursal --lleva el nombre de la sucursal-- que en la pantalla suelta,
   * y a ancho de movil los controles se van a una segunda linea.
   *
   * Un desfase de pocos pixeles no rompe nada visible: deja una rendija por la
   * que asoman las filas al scrollear, o tapa el borde de la cabecera. Por eso
   * se mide y se publica como variable CSS, y el `3.5rem` del `thead` es solo
   * el valor con el que pinta el primer frame.
   */
  const barraRef = useRef<HTMLDivElement | null>(null);
  const marcoRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const barra = barraRef.current;
    const marco = marcoRef.current;
    if (!barra || !marco) return;
    const medir = () =>
      marco.style.setProperty("--lo-pnl-controls-h", `${barra.offsetHeight}px`);
    medir();
    // El observador basta como unica dependencia real: la barra cambia de alto
    // por texto o por ancho de ventana, y las dos cosas las ve el.
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(medir);
    ro.observe(barra);
    return () => ro.disconnect();
  }, []);
  /*
   * ⚠ SOLO "producer" ABIERTO, Y LOS OTROS TRES PLEGADOS PERO PRESENTES.
   *
   * Pestañas habrian escondido que los otros grupos existen, y los 62 de
   * support con -410.170 SON parte del P&L de la sucursal. Apilado y plegado
   * resuelve las dos cosas: no ocupan media pantalla y su total se ve sin
   * abrirlos.
   *
   * Y apilado permite la lectura que con pestañas se pierde: cuanto produce la
   * sucursal contra cuanto cuesta el soporte que no produce.
   */
  const [gruposAbiertos, setGruposAbiertos] = useState<Set<OfficerGroup>>(
    () => new Set<OfficerGroup>(["producer"]),
  );
  const alternarGrupo = (g: OfficerGroup) =>
    setGruposAbiertos((prev) => {
      const n = new Set(prev);
      if (n.has(g)) n.delete(g);
      else n.add(g);
      return n;
    });

  const cargar = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const p = all ? "all=1" : `month=${encodeURIComponent(month)}&year=${year}`;
      // La sucursal acota los CIERRES, no la nomina: ver la nota en la ruta.
      const q = branch ? `${p}&branch=${encodeURIComponent(branch)}` : p;
      const res = await fetch(`/api/lo-pnl?${q}`);
      const json = await res.json();
      if (!res.ok) { setError(json.error ?? "Failed to load"); return; }
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [all, month, year, branch]);

  useEffect(() => { cargar(); }, [cargar]);

  const officers = data?.officers ?? [];
  const totales = useMemo(() => ({
    prestamos: officers.reduce((s, o) => s + o.loanCount, 0),
    volumen: officers.reduce((s, o) => s + o.volume, 0),
    produccion: officers.reduce((s, o) => s + o.block1Net, 0),
    revenue: officers.reduce((s, o) => s + o.block1Revenue, 0),
    costesDirectos: officers.reduce((s, o) => s + o.block1DirectCosts, 0),
    otros: officers.reduce((s, o) => s + o.block1OtherBooked, 0),
    comision: officers.reduce((s, o) => s + o.block1Commission, 0),
    contribucion: officers.reduce((s, o) => s + o.contribution, 0),
    fuera: officers.reduce((s, o) => s + o.block1Elsewhere, 0),
    coste: officers.reduce((s, o) => s + o.block2Total, 0),
    neto: officers.reduce((s, o) => s + o.total, 0),
  }), [officers]);

  const personaAbierta = abierto
    ? officers.find((o) => (o.personCode ?? o.name) === abierto) ?? null
    : null;

  const sinNomina = officers.filter((o) => o.payrollStatus === "not_located" && o.loanCount > 0);
  const fueraDeNomina = officers.filter((o) => o.commissionOutsidePayroll);

  return (
    <div ref={marcoRef} className="flex flex-col gap-4">
      {/*
        * ─────────────────────────────────────────────────────────────────────
        * LOS CONTROLES NO SE VAN CON EL SCROLL
        * ─────────────────────────────────────────────────────────────────────
        *
        * Con 38 productores abiertos la tabla pasa de dos pantallas, y el
        * selector de periodo se quedaba arriba del todo. Quien bajaba a mirar
        * una fila y queria cambiar de mes tenia que volver a subir, y --peor--
        * dejaba de ver a que periodo pertenecian las cifras que estaba leyendo.
        *
        * Fondo SOLIDO, no translucido: debajo pasan filas con numeros, y un
        * fondo con transparencia los deja asomar detras del texto de la barra.
        */}
      <div
        ref={barraRef}
        className="sticky top-0 z-30 -mt-1 flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 bg-white px-0.5 py-2 shadow-[0_2px_4px_-2px_rgba(0,0,0,0.12)]"
      >
        <div className="flex items-center gap-2">
          {branch ? (
            <h2 className="text-sm font-semibold text-[#001A40]">
              Loan officers of branch {branch}
            </h2>
          ) : (
            <h1 className="text-base font-bold text-[#001A40]">P&amp;L by Loan Officer</h1>
          )}
          {/*
            * ⚠ LAS SALVEDADES DE PANTALLA VIVEN EN UN BOTON, NO EN PARRAFOS.
            *
            * Eran tres parrafos encima de la tabla, y en el modal de sucursal
            * ocupaban mas alto que las primeras filas. Plegadas siguen a un
            * clic de distancia; abiertas en la pantalla empujan el dato que se
            * viene a ver fuera de la vista.
            *
            * El boton CUENTA cuantas hay, para que plegarlas no las esconda.
            */}
          <button
            onClick={() => setAvisosAbiertos((v) => !v)}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] ${
              avisosAbiertos
                ? "border-amber-300 bg-amber-50 text-amber-800"
                : "border-gray-200 bg-white text-gray-500 hover:bg-gray-50"
            }`}
            title="What these figures do and do not cover"
          >
            <HelpCircle size={11} />
            {branch ? "3 things to know" : "2 things to know"}
          </button>
        </div>

        {/* El periodo: por defecto el mes de cierre, el mismo que Where to start. */}
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-gray-200 overflow-hidden">
            <button onClick={() => setAll(false)}
              className={`px-3 py-1 text-xs ${!all ? "bg-blue-600 text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}>
              One month
            </button>
            <button onClick={() => setAll(true)}
              className={`px-3 py-1 text-xs ${all ? "bg-blue-600 text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}>
              All months
            </button>
          </div>
          {!all && (
            <>
              <select value={month} onChange={(e) => setMonth(e.target.value)}
                className="h-7 rounded-lg border border-gray-200 bg-white px-2 text-xs">
                {MONTH_NAMES_IN_ORDER.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <select value={year} onChange={(e) => setYear(e.target.value)}
                className="h-7 rounded-lg border border-gray-200 bg-white px-2 text-xs">
                {[def.year - 1, def.year, def.year + 1].map((y) => (
                  <option key={y} value={String(y)}>{y}</option>
                ))}
              </select>
            </>
          )}
        </div>
      </div>

      {avisosAbiertos && (
        <div className="-mt-2 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-[11px] leading-relaxed text-gray-600 space-y-2">
          <p>
            <span className="font-semibold text-gray-700">Net is produced minus payroll.</span>{" "}
            The commission column is shown because it is the business question — what this person
            earned on their closings — but it is <span className="font-medium">not</span> subtracted:
            that money is paid through payroll, and subtracting both would count it twice.
          </p>
          {/*
            * ⚠ ESTA SALVEDAD ES NUEVA Y CAMBIA LO QUE SIGNIFICA CADA CIFRA DE
            * LA PANTALLA, asi que va la primera. Antes se contaba todo el P&L
            * del prestamo; ahora solo lo contabilizado en su sucursal, que es
            * el 77,2%.
            */}
          <p>
            <span className="font-semibold text-gray-700">
              Only what the loan’s own branch books.
            </span>{" "}
            A loan’s revenue is not all booked in the branch that produced it — most of the
            division margin lands in 700. Those lines are real and they are shown, under
            “Booked elsewhere”, but they are not counted in any column here: across the division
            that is {usdExacto(Math.abs(totales.fuera))} of the closings’ revenue. Branch
            “Affinity” is read as 716, which is where its loans are booked.
          </p>
          <p>
            <span className="font-semibold text-gray-700">
              Commission and payroll are two calendars.
            </span>{" "}
            Compensafe groups by closing date and the P&amp;L by payment date, so a loan closed at
            the end of a month is paid in the next period. The two columns are not meant to match.
          </p>
          {branch && (
            <>
              {/*
                * ⚠ EL PERIODO NO SIGUE AL MODAL, Y HAY QUE DECIRLO.
                *
                * Dos alcances distintos en la misma ventana es de las cosas que
                * mas confunden, asi que no puede quedar implicito. La razon es
                * medida: Sergio Vermejo cerro UNA VEZ en noviembre de 2025 y
                * siguio costando hasta mayo de 2026. Heredando el mes del modal
                * desaparece de cualquier vista posterior, y con el el unico caso
                * que enseña por que este modulo existe.
                *
                * La sucursal SI se hereda: esa pregunta es la misma en las dos.
                */}
              <p className="text-amber-700">
                <span className="font-semibold">The branch is inherited, the period is not.</span>{" "}
                Branch {branch} comes from this window; the period has its own selector above,
                because “does this person pay for themselves” only makes sense over time.
              </p>
              {/*
                * ⚠ EL COSTE NO SE PUEDE REPARTIR POR SUCURSAL, Y HAY QUE DECIRLO.
                *
                * La nomina sale de las cuentas de compensacion y no lleva
                * sucursal de produccion. Asi que aqui cada persona trae su coste
                * ENTERO contra lo que produjo SOLO en esta sucursal.
                *
                * Medido: de los 45 loan officers con cierres, 29 cierran en una
                * sola sucursal --para ellos la cifra es exacta-- y 16 en varias.
                * Gian Laino cierra en cinco: 17 en la 747, 3 en la 716, 2 en la
                * 710, y una en la 760 y en Affinity. En la vista de la 747 carga
                * su nomina completa contra 17 de sus 24 cierres.
                *
                * No se reparte porque no hay con que: inventar un prorrateo por
                * numero de cierres o por volumen seria un dato que nadie ha
                * decidido, presentado como si fuera contabilidad.
                */}
              <p className="text-slate-500">
                <span className="font-semibold text-gray-700">
                  Cost is whole, production is only this branch.
                </span>{" "}
                Payroll has no branch, so each person carries their entire payroll against what they
                produced here alone. For the 29 officers who only close here that is exact; for the
                16 who close in several branches it overstates the cost in each one.
              </p>
            </>
          )}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
      )}

      {loading && <div className="text-xs text-gray-400">Loading…</div>}

      {!loading && data && officers.length === 0 && (
        /* Correcto que no haya nada, y hay que decirlo: en blanco se lee como roto. */
        <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-6 text-center text-xs text-gray-500">
          No loan officers with closings or payroll in {all ? "any period" : `${month} ${year}`}.
        </div>
      )}

      {!loading && data && officers.length > 0 && (
        <>
          <div className="rounded-xl border border-gray-200">
            <table className="w-full text-xs">
              {/*
                * ⚠ LAS CABECERAS SE FIJAN, LAS DE SECCION NO.
                *
                * Con 36 productores abiertos la tabla pasa de una pantalla y se
                * perdia que columna era cual. Las de seccion --Producers,
                * Support...-- scrollean con su contenido a proposito: son parte
                * de la lista, no del marco.
                */}
              <thead className="sticky top-[var(--lo-pnl-controls-h,3.5rem)] z-20 bg-gray-100 shadow-[0_1px_0_rgba(0,0,0,0.08)]">
                <tr className="text-left text-gray-600 border-b border-gray-300">
                  <th className="px-3 py-2 font-medium">Producer</th>
                  <th className="px-3 py-2 font-medium text-right">Loans</th>
                  <th className="px-3 py-2 font-medium text-right">Volume</th>
                  {/*
                    * ─────────────────────────────────────────────────────────
                    * DOS FINALES, Y NO SE PUEDEN ENCADENAR
                    * ─────────────────────────────────────────────────────────
                    *
                    * La escalera --gross revenue, costes directos, comision--
                    * termina en CONTRIBUTION: lo que dejaron sus prestamos
                    * despues de pagarle a el. Es una pregunta sobre PRESTAMOS.
                    *
                    * El NET termina en otro sitio: produced menos la nomina
                    * entera. Es una pregunta sobre la PERSONA.
                    *
                    * ⚠ Y RESTARLE LA NOMINA A CONTRIBUTION CONTARIA LA COMISION
                    * DOS VECES, porque la comision SE PAGA POR LA NOMINA. Esta
                    * medido: 1.163.656,81 de comision viven dentro de una nomina
                    * de 5.362.891,98 -- encadenar los dos finales duplicaria el
                    * 21,7% del coste de la division.
                    *
                    * Por eso las dos cifras estan separadas por una linea y cada
                    * una dice de que sale. No son dos pasos: son dos preguntas.
                    */}
                  <th className="px-3 py-2 font-medium text-right" title="What the loans left before paying the loan officer. category_6 = 'Revenue'.">
                    Gross revenue
                  </th>
                  <th className="px-3 py-2 font-medium text-right" title="Appraisal, credit report, verification. Shown with its own sign — these usually ADD, because they are charged to the borrower and come back to the branch.">
                    Direct costs
                  </th>
                  <th className="px-3 py-2 font-medium text-right" title="What Compensafe paid them for those loans.">
                    LO commission
                  </th>
                  <th className="px-3 py-2 font-medium text-right border-r border-gray-300" title="Gross revenue plus direct costs, minus the commission. What their loans left the branch after paying them.">
                    Contribution
                  </th>
                  <th className="px-3 py-2 font-medium text-right" title="What the P&L records as paid to this person: salary, commission, bonus, taxes, insurance, equipment. The commission above is already inside this figure.">
                    Payroll paid
                  </th>
                  <th className="px-3 py-2 font-medium text-right" title="Gross revenue plus direct costs, minus payroll paid. The commission is NOT subtracted again here — it is already inside payroll.">
                    Net <span className="font-normal text-gray-400">= Produced − Payroll</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {SECCIONES.map((sec) => {
                  const miembros = officers.filter((o) => o.group === sec.key);
                  if (miembros.length === 0) return null;
                  const seccionAbierta = gruposAbiertos.has(sec.key);
                  const netoSeccion = miembros.reduce((s, o) => s + o.total, 0);
                  const cierresSeccion = miembros.reduce((s, o) => s + o.loanCount, 0);
                  const contribucionSeccion = miembros.reduce((s, o) => s + o.contribution, 0);
                  const nominaSeccion = miembros.reduce((s, o) => s + o.block2Total, 0);

                  return (
                    <Fragment key={sec.key}>
                      {/*
                        * ⚠ LA CABECERA PLEGADA LLEVA CONTEO **Y** NETO. Una que
                        * solo dijera "Support (62)" esconderia los -410.170, y
                        * entonces plegar dejaria de ser una comodidad para
                        * pasar a ocultar dinero.
                        */}
                      <tr
                        onClick={() => alternarGrupo(sec.key)}
                        className="cursor-pointer border-b border-gray-200 bg-gray-50/80 hover:bg-gray-100"
                      >
                        <td className="px-3 py-2" colSpan={3}>
                          <span className="inline-flex items-center gap-1.5">
                            {seccionAbierta
                              ? <ChevronDown size={13} className="text-gray-500" />
                              : <ChevronRight size={13} className="text-gray-500" />}
                            <span className="font-semibold text-gray-800">{sec.label}</span>
                            <span className="text-gray-500">({miembros.length})</span>
                            {cierresSeccion > 0 && (
                              <span className="text-[11px] text-gray-400">
                                · {cierresSeccion} closing{cierresSeccion === 1 ? "" : "s"}
                              </span>
                            )}
                            {/*
                              * ⚠ LA EXPLICACION DEL GRUPO, EN UN ICONO Y NO EN
                              * UN PARRAFO. Cuatro parrafos intercalados entre
                              * las filas partian la tabla en cuatro tablas: la
                              * vista se pierde al bajar, y el ojo deja de poder
                              * comparar una columna de arriba abajo. El texto es
                              * el mismo, colgado del titulo que describe.
                              */}
                            {/*
                              * El `title` va en el <span>, no en el icono: en un
                              * <svg> el atributo `title` no enseña tooltip --hace
                              * falta un <title> hijo-- y el aviso se perderia sin
                              * que nada pareciera roto.
                              */}
                            <span title={sec.hint} className="inline-flex cursor-help text-gray-300 hover:text-gray-500">
                              <HelpCircle size={11} />
                            </span>
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right" colSpan={3} />
                        {/*
                          * La cabecera plegada lleva los DOS finales, no solo
                          * el neto. Con uno solo, plegar la seccion escondia
                          * cual de las dos preguntas se estaba contestando.
                          */}
                        <td className="px-3 py-2 text-right border-r border-gray-300">
                          <span className={`font-semibold font-mono tabular-nums ${contribucionSeccion < 0 ? "text-red-600" : "text-gray-700"}`}>
                            {usd(contribucionSeccion)}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right text-gray-600">{usd(-nominaSeccion)}</td>
                        <td className="px-3 py-2 text-right">
                          <span className={`font-semibold font-mono tabular-nums ${netoSeccion < 0 ? "text-red-600" : "text-gray-800"}`}>
                            {usd(netoSeccion)}
                          </span>
                        </td>
                      </tr>

                      {seccionAbierta && miembros.map((o) => {
                  const id = o.personCode ?? o.name;
                  const abre = abierto === id;
                  return (
                    // La key va en el Fragment, no en el <tr>: una fila y su
                    // detalle son DOS hermanos de la misma lista, y React pide
                    // la key en el elemento raiz de cada iteracion.
                    <Fragment key={id}>
                      <tr
                        onClick={() => setAbierto(abre ? null : id)}
                        className={`cursor-pointer border-b border-gray-100 hover:bg-blue-50/60 ${
                          abre ? "bg-blue-50" : ""
                        }`}>
                        <td className="px-3 py-1.5">
                          <span className="inline-flex items-center">
                            {/*
                              * Siempre a la derecha: ya no despliega hacia abajo,
                              * abre un panel al lado. Un chevron que apuntara
                              * hacia abajo prometeria un sitio donde mirar que no
                              * existe.
                              */}
                            <ChevronRight size={12}
                              className={`mr-1 ${abre ? "text-blue-600" : "text-gray-400"}`} />
                            <span className="font-medium text-gray-800">{o.name}</span>
                          </span>

                          {/* Las salvedades, SOLO en la fila que afectan. */}
                          {o.loanCount > 0 && o.payrollStatus === "not_located" && (
                            <Marca tono="ambar"
                              title="No payroll row anywhere in the P&L carries this name. This is not a zero: it is an absence, and it is the finding this module exists to surface.">
                              no payroll found for this person
                            </Marca>
                          )}
                          {/*
                            * "counted", no "found", y la palabra es la marca.
                            * Susan Aguilar y Silvio Arteaga SI tienen filas de
                            * nomina --3 y 2-- pero por formas fragiles que
                            * quedan fuera del total. "No encontrada" seria
                            * falso de ellas; "no contada" es cierto de las
                            * tres, y es lo que el lector necesita saber: el
                            * total miente sobre esta persona.
                            */}
                          {o.commissionOutsidePayroll && (
                            <Marca tono="ambar"
                              title="Commission was recorded for this person, but no payroll is counted in their total — either none was found, or what was found came through description shapes too weak to include. Their cost here is understated.">
                              commission recorded, no payroll counted
                            </Marca>
                          )}
                          {o.payrollStatus === "fragile_only" && (
                            <Marca title="Only found through less reliable description shapes. Shown in the detail, outside the total.">
                              payroll matched with low confidence
                            </Marca>
                          )}
                          {o.loanCount === 0 && (
                            <Marca title="This person has payroll but closed no loans in this period.">payroll, no closings</Marca>
                          )}
                          {o.truncatedRows > 0 && (
                            <Marca title={`${o.truncatedRows} row(s) arrived at the 35-character limit, so the name may be cut.`}>
                              {o.truncatedRows} cost line{o.truncatedRows === 1 ? "" : "s"} could not be matched to a person
                            </Marca>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-right text-gray-600">{o.loanCount || "—"}</td>
                        <td className="px-3 py-1.5 text-right text-gray-600">{o.volume ? usd(o.volume) : "—"}</td>
                        <td className="px-3 py-1.5 text-right">
                          {o.loanCount ? usd(o.block1Revenue) : "—"}
                          {o.block1Elsewhere !== 0 && (
                            <span className="ml-1 text-[10px] text-gray-400"
                                  title="Booked on their loans but in another branch — mostly division margin in 700 — so it is not counted here.">
                              {usd(o.block1Elsewhere, { signo: true })} elsewhere
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          {o.loanCount ? usd(o.block1DirectCosts) : "—"}
                          {/*
                            * Lo que no cae en ninguno de los dos grupos va
                            * pegado aqui y DICHO, no sumado en silencio: es un
                            * solo prestamo en toda la division y esconderlo por
                            * raro seria el error que la escalera evita.
                            */}
                          {o.block1OtherBooked !== 0 && (
                            <span className="ml-1 text-[10px] text-slate-500"
                                  title="Booked against their loans but neither revenue nor a direct production cost. It is inside the contribution.">
                              {usd(o.block1OtherBooked, { signo: true })} other
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-right text-gray-500">
                          {o.commission ? usd(-o.commission) : "—"}
                        </td>
                        <td className={`px-3 py-1.5 text-right border-r border-gray-200 font-mono tabular-nums ${colorNeto(o.contribution)}`}>
                          {o.loanCount ? usd(o.contribution) : "—"}
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          {o.payrollStatus === "not_located" ? (
                            <span className="text-amber-600" title="No payroll found for this person. Not the same as a zero.">—</span>
                          ) : o.commissionExceedsPayroll ? (
                            /*
                              * ⚠ LA MARCA DICE LO QUE SE VE, NO DIAGNOSTICA.
                              * La columna enseña la nomina localizada, que es un
                              * hecho; que sea MENOR que la comision es el hallazgo,
                              * y sus causas son varias --el P&L del periodo sin
                              * cargar, la nomina sin atribuir, la comision mal
                              * cruzada--. Haydee Tito-Pace fue la que lo enseño:
                              * 1.292 de nomina contra 32.179 de comision, y la
                              * causa resulto ser la sucursal 728 sin cargar.
                              */
                            <span
                              className="font-medium text-amber-700"
                              title="Less payroll is located for this person than the commission recorded for their loans, so the cost here is understated. Causes vary — the period's P&L may not be loaded, payroll may not be attributed, or the commission may be crossed wrong."
                            >
                              {usd(-o.block2Total)}
                            </span>
                          ) : (
                            usd(-o.block2Total)
                          )}
                        </td>
                        {/*
                          * ⚠ `total`, NO `net`, Y NO SALE DE `contribution`.
                          *
                          * total = produced - nomina, donde produced es gross
                          * revenue + costes directos + otros. Se reconstruye de
                          * las columnas que tiene al lado SALTANDOSE la comision
                          * y la contribucion, a proposito: la comision ya esta
                          * dentro de la nomina, y restarla otra vez duplicaria
                          * 1.163.656,81 en la division.
                          */}
                        <td className={`px-3 py-1.5 text-right font-semibold font-mono tabular-nums ${colorNeto(o.total)}`}>
                          {usd(o.total)}
                        </td>
                      </tr>
                      {/*
                        * ⚠ EL PANEL NO SE PINTA AQUI. Un <aside> colgado del
                        * <tbody> lo saca el navegador de la tabla al parsear
                        * --el contenido de una tabla solo admite filas-- y se
                        * pierde a mitad de camino. Vive al final del componente,
                        * fuera de la <table>, y la fila solo guarda a quien
                        * abrio.
                        */}
                    </Fragment>
                  );
                      })}
                    </Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="bg-gray-50 border-t-2 border-gray-300 font-semibold text-gray-700">
                  <td className="px-3 py-2">{officers.length} people</td>
                  <td className="px-3 py-2 text-right">{totales.prestamos}</td>
                  <td className="px-3 py-2 text-right">{usd(totales.volumen)}</td>
                  <td className="px-3 py-2 text-right">
                    {usd(totales.revenue)}
                    {totales.fuera !== 0 && (
                      <span className="ml-1 text-[10px] font-normal text-gray-400"
                            title="Booked on these loans but in another branch — mostly division margin in 700. Not counted in any column here.">
                        {usd(totales.fuera, { signo: true })} elsewhere
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {usd(totales.costesDirectos)}
                    {totales.otros !== 0 && (
                      <span className="ml-1 text-[10px] font-normal text-slate-500">
                        {usd(totales.otros, { signo: true })} other
                      </span>
                    )}
                  </td>
                  {/*
                    * ⚠ AHORA SI SE TOTALIZA LA COMISION, y antes no. La razon de
                    * no hacerlo era que estaba al lado de una resta de la que no
                    * formaba parte, asi que sumarla invitaba a restarla. Con la
                    * escalera SI forma parte de la resta de su columna --la
                    * contribucion-- y callar su total dejaria el unico escalon
                    * sin cerrar.
                    */}
                  <td className="px-3 py-2 text-right">{usd(-totales.comision)}</td>
                  <td className={`px-3 py-2 text-right border-r border-gray-300 font-mono tabular-nums ${colorNeto(totales.contribucion)}`}>
                    {usd(totales.contribucion)}
                  </td>
                  <td className="px-3 py-2 text-right">{usd(-totales.coste)}</td>
                  <td className={`px-3 py-2 text-right font-mono tabular-nums ${colorNeto(totales.neto)}`}>{usd(totales.neto)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/*
            * LA NOTA, PLEGADA. Aqui viven las salvedades largas -- las que valen
            * para toda la pantalla y no para una fila. Plegada a proposito:
            * nadie tiene que abrirla para leer una cifra, y quien pregunte por
            * un numero concreto la encuentra donde la busca.
            */}
          <div className="rounded-xl border border-gray-200 overflow-hidden">
            <button onClick={() => setNotaAbierta((v) => !v)}
              className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-gray-50">
              {notaAbierta ? <ChevronDown size={13} className="text-gray-400" />
                           : <ChevronRight size={13} className="text-gray-400" />}
              <Info size={12} className="text-gray-400" />
              <span className="text-[11px] font-medium text-gray-600">How to read these numbers</span>
              <span className="text-[11px] text-gray-400">
                — the commission is not subtracted, and {sinNomina.length} officer
                {sinNomina.length !== 1 ? "s have" : " has"} no payroll located
              </span>
            </button>

            {notaAbierta && (
              <div className="border-t border-gray-200 px-4 py-3 text-[11px] leading-relaxed text-gray-600 space-y-3">
                <div>
                  <span className="font-semibold text-gray-700">“Paid on loans” is not subtracted from Net.</span>{" "}
                  It is the same money as the payroll, arriving by a second road: the commission is paid
                  through the compensation accounts. Subtracting it as well would count it twice. We tried to
                  identify which payroll rows are commission by matching amounts, and it only works for 65 rows
                  out of about 700 — Steve Badovinac matches 10 of his 11 rows in 60115, but Cristhian Ramirez
                  matches 0 of 23. So the P&amp;L decides: Net = produced + cost.
                </div>

                <div>
                  <span className="font-semibold text-gray-700">“No payroll” means absent, never zero.</span>{" "}
                  {sinNomina.length > 0
                    ? <>Right now that is {sinNomina.map((o) => o.name).join(", ")}. Not one row in the whole
                       P&amp;L carries their name — Brian Heibel closed 20 loans and cost nothing the books can see.</>
                    : <>No officer is in that state in this period.</>}
                </div>

                {fueraDeNomina.length > 0 && (
                  <div>
                    <span className="font-semibold text-gray-700">Commission recorded, no payroll counted.</span>{" "}
                    {fueraDeNomina.map((o) => o.name).join(", ")} earned commission, but nothing reaches
                    their payroll total — either no row carries their name, or the rows that do came through
                    description shapes too weak to include. Their cost here is understated by{" "}
                    {usdExacto(Math.abs(data.commissionOutsidePayrollTotal))}.
                  </div>
                )}

                {data.collapsedPairs.length > 0 && (
                  <div>
                    <span className="font-semibold text-gray-700">Two rows, one person.</span>{" "}
                    {data.collapsedPairs.map((p) => (
                      <span key={p.personCode}>
                        The source resolves {p.names.join(" and ")} to the same person ({p.personCode}), and
                        the loan file keeps them apart. Read their figures together, not separately. It is
                        fixed upstream, not here.
                      </span>
                    ))}
                  </div>
                )}

                {data.splitByShape.length > 0 && (
                  /*
                   * ⚠ ESTO ANTES COLGABA DE `!nameKeyAvailable`, Y POR ESO NO SE
                   * VEIA CUANDO HACIA FALTA. El aviso describia exactamente la
                   * fila partida, pero su condicion miraba la CAUSA que se
                   * conocia entonces --que faltara el espejo--. El 2026-09-14,
                   * con el espejo ya poblado, la tabla seguia enseñando "July
                   * Castro" con -248.533 y ningun cierre junto a "Julymar Mar
                   * Castro" con 2 prestamos y sin nomina, y el aviso callado.
                   *
                   * Se partio por otra causa: una entrada suelta sin person_code
                   * gana por la via `exact` y tapa a la persona real, asi que
                   * `ends` no llega a probarse. Ver findSplitByShape.
                   *
                   * Un aviso ausente NO se lee como "no lo sabemos": se lee como
                   * "aqui no hay nada raro". Por eso ahora cuelga del SINTOMA, que
                   * es el mismo se parta por lo que se parta, y nombra las filas
                   * en vez de describir la forma en abstracto.
                   */
                  <div>
                    <span className="font-semibold text-amber-700">Two rows, one person — and the source does not know it.</span>{" "}
                    {data.splitByShape.map((s) => (
                      <span key={s.conPrestamos}>
                        “{s.conPrestamos}” has closings and no payroll, while “{s.conNomina}” has payroll and
                        no closings. Both names share {s.extremos[0]} … {s.extremos[1]}, so they are almost
                        certainly the same person, split because their spellings could not be tied together.
                        Each half reads as a finding that is not real: read the two rows together, not
                        separately.{" "}
                      </span>
                    ))}
                    Money is never moved to the wrong person, but a person can be counted as two. It is fixed
                    upstream, not here.
                  </div>
                )}

                {!data.nameKeyAvailable && (
                  /*
                   * El espejo ausente sigue mereciendo su propio aviso: no solo
                   * parte filas --eso ya lo dice el de arriba, y mejor, porque las
                   * nombra-- sino que baja la tasa de acierto de 34 a 31 sobre 46,
                   * y eso no tiene sintoma visible en ninguna fila.
                   */
                  <div>
                    <span className="font-semibold text-amber-700">Name resolution is degraded.</span>{" "}
                    The mirror of the source’s spelling table is not available
                    {data.nameKeyNote ? ` (${data.nameKeyNote})` : ""}, so fewer names resolve than usual and
                    more people fall to “no payroll” without that being true of them. Treat every extreme row
                    as unconfirmed until it is back.
                  </div>
                )}

                {data.unattributed.rows.length > 0 && (
                  <div>
                    <span className="font-semibold text-gray-700">Not attributed to anyone.</span>{" "}
                    {data.unattributed.rows.length} rows, {usdExacto(data.unattributed.total)}. Names the
                    matcher could not resolve to one person. They are never split across people and never
                    silently dropped into someone’s total.
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/*
        * El panel, fuera de la tabla y con la persona buscada por su id. Se
        * busca en vez de guardarse el objeto para que al recargar --otro mes,
        * otra sucursal-- el panel enseñe las cifras NUEVAS de esa persona, o se
        * cierre solo si ya no esta. Guardando el objeto se quedaria enseñando
        * el periodo anterior con los controles diciendo otra cosa.
        */}
      {personaAbierta && (
        <PanelDetalle o={personaAbierta} onClose={() => setAbierto(null)} />
      )}
    </div>
  );
}
