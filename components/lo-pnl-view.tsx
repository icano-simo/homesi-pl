"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, AlertTriangle, Info, HelpCircle, X } from "lucide-react";
import { closePeriod, MONTH_NAMES_IN_ORDER } from "@/lib/close-period";
import { LoanPnlCard } from "@/components/loan-pnl-card";
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

/**
 * Puntos basicos sobre una base, o "—" cuando no hay base que dividir.
 *
 * ⚠ LA BASE ES EL IMPORTE DE **ESE** PRESTAMO, nunca el volumen del periodo.
 * Es la misma definicion que usa el detalle de prestamos --`bps(net, amount)`--
 * y es lo unico que permite comparar un cierre de 200.000 con uno de 900.000:
 * en dolares gana siempre el segundo, en bps se ve cual rindio.
 */
function bps(v: number | null | undefined, base: number | null | undefined) {
  if (v == null || !base) return "—";
  return ((v / base) * 10000).toFixed(1);
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
    /*
     * ⚠ AQUI DENTRO VIVE 55601 One-Time Transfers, que no es un coste de
     * produccion sino un traslado entre sucursales -- positivo donde se recibe,
     * negativo donde se cede, y casi cero sumando la division entera. Por eso
     * un prestamo suelto puede llevar +12.450 o -32.144 en este escalon sin que
     * nada este mal. El porque completo, con las cifras, esta en la nota de
     * `directCosts` en app/api/lo-pnl/route.ts.
     */
    label: "Direct production costs",
    hint: "Appraisal, credit report, verification — and branch-to-branch transfers (55601), which is why this line can be unusually large on a single loan. Shown with its own sign: these usually ADD, because they are charged to the borrower and come back to the branch.",
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
 * Los dos destinos de lo que NO se queda la sucursal del prestamo.
 *
 * ⚠ SON DOS Y NO UNO PORQUE SIGNIFICAN COSAS DISTINTAS. Lo de la 700 es el
 * reparto normal --corporativo se queda su parte, 1.138.272,02 en la division,
 * casi todo DM Margin--. Lo de una tercera sucursal son 85.073,08 de margen
 * apuntado donde no toca y traslados de compensacion, y eso si es una pregunta.
 * Bajo una sola etiqueta, la segunda desaparece dentro de la primera.
 */
const DESTINOS = [
  {
    key: "division" as const,
    label: "Kept by the division (700)",
    suyo: (x: LoanLine) => x.branch === "700",
  },
  {
    key: "otra" as const,
    label: "Booked in another branch",
    suyo: (x: LoanLine, l: LoanRow) => x.branch !== "700" && x.branch !== l.branch,
  },
];

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
 * TODA LA PROSA DEL PANEL, EN UN SITIO Y DETRAS DE UN BOTON
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ ESTABA REPARTIDA ENTRE LAS TARJETAS Y ESE ERA EL PROBLEMA. Cada salvedad
 * se habia escrito junto al numero que afectaba --que parecia lo correcto-- y
 * el resultado era un panel donde entre dos cifras habia siempre un parrafo:
 * el ojo no podia bajar por una columna sin cruzar texto, y el panel no cabia
 * en la ventana.
 *
 * Ninguna se borra. Se juntan aqui, ordenadas de la que mas cambia una cifra a
 * la que menos, y el panel se queda solo con numeros.
 */
function AyudaPnl({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const alPulsar = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", alPulsar);
    return () => window.removeEventListener("keydown", alPulsar);
  }, [onClose]);

  return (
    <>
      <div className="fixed inset-0 z-[80] bg-slate-900/40" onClick={onClose} />
      <div
        role="dialog"
        aria-label="How this P&L is calculated"
        className="fixed left-1/2 top-1/2 z-[90] w-[min(46rem,calc(100vw-2rem))] max-h-[min(44rem,calc(100vh-4rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4">
          <h3 className="text-sm font-semibold text-[#001A40]">How this P&amp;L is calculated</h3>
          <button onClick={onClose} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="mt-4 space-y-4 text-[11px] leading-relaxed text-gray-600">
          <section>
            <h4 className="text-[11px] font-semibold text-gray-800">The ladder</h4>
            <p className="mt-1">
              A loan&rsquo;s result is read in steps: gross revenue, plus direct production costs,
              minus what the loan officer was paid, equals what the loan left the branch.
            </p>
            <p className="mt-1">
              <span className="font-medium text-gray-700">Direct costs ADD, they do not subtract.</span>{" "}
              They come out positive because they are charged to the borrower and come back to the
              branch &mdash; +416,70 on loan 710002042266. The sign is shown as it is; the label
              never says &ldquo;minus&rdquo;.
            </p>
          </section>

          <section>
            <h4 className="text-[11px] font-semibold text-gray-800">
              Why there are two totals, and why they must not be chained
            </h4>
            <p className="mt-1">
              <span className="font-medium text-gray-700">Total contribution</span> answers a
              question about loans: what did they leave after paying the officer.{" "}
              <span className="font-medium text-gray-700">Net</span> answers one about the person:
              do they pay for themselves. Net starts again from what was produced, not from the
              contribution.
            </p>
            <p className="mt-1">
              Subtracting payroll from the contribution would count the same money twice, because
              the commission is paid <em>through</em> payroll. Across the division that is
              1.163.656,81 of commission inside a payroll of 5.362.891,98 &mdash; 21,7% of the
              cost, counted again.
            </p>
            <p className="mt-1">
              The two also sit on different calendars and are not meant to match: Compensafe groups
              commission by closing date, the P&amp;L records payroll by payment date.
            </p>
          </section>

          <section>
            <h4 className="text-[11px] font-semibold text-gray-800">Only the loan&rsquo;s own branch</h4>
            <p className="mt-1">
              Revenue is not all booked where the loan was produced. What another branch books is
              real, is shown under &ldquo;Not part of this branch&rsquo;s contribution&rdquo;, and is
              counted in no column. Most of it is division margin in 700, which is the normal
              split; what lands in a third branch is not, and is listed separately.
            </p>
            <p className="mt-1">
              So <span className="font-medium text-gray-700">&ldquo;Produced&rdquo; is not
              everything the person generated.</span> Against Compensafe or an officer&rsquo;s own
              production report it comes out lower, and the gap is what other branches book.
            </p>
            <p className="mt-1">
              Branch &ldquo;Affinity&rdquo; is read as 716, where its loans are booked. Branches 776
              and 150 carry no entries at all in the ledger, so their loans cannot show revenue of
              their own &mdash; that is not the same as having earned nothing.
            </p>
          </section>

          <section>
            <h4 className="text-[11px] font-semibold text-gray-800">Cost is whole, production is one branch</h4>
            <p className="mt-1">
              Payroll has no branch, so inside a branch view each person carries their entire
              payroll against what they produced there alone. For the 29 officers who only close in
              one branch that is exact; for the 16 who close in several it overstates the cost in
              each one.
            </p>
          </section>

          <section>
            <h4 className="text-[11px] font-semibold text-gray-800">Absences are not zeros</h4>
            <p className="mt-1">
              &ldquo;No payroll located&rdquo; means no row in the whole P&amp;L carries that name
              &mdash; it is an absence, and it is the finding this module exists to surface. A loan
              that does not cross with Compensafe has an unknown commission, not a zero one, and it
              is left out of the contribution rather than counted as free.
            </p>
            <p className="mt-1">
              Payroll found only through weaker description shapes &mdash; &ldquo;ZOOMPLUS-NAME&rdquo;,
              &ldquo;SALESFORCE USER FOR NAME&rdquo; &mdash; is shown but left out of the total, and
              said so where it happens.
            </p>
          </section>

          <section>
            <h4 className="text-[11px] font-semibold text-gray-800">Two accounts worth knowing about</h4>
            <p className="mt-1">
              <span className="font-mono text-gray-700">55601 One-Time Transfers</span> sits inside
              direct production costs and is a branch-to-branch transfer, not a production cost:
              positive where it is received, negative where it is given up, and close to zero across
              the whole division. That is why a single loan can carry +12.450,00 or &minus;32.144,00
              on that line with nothing wrong.
            </p>
            <p className="mt-1">
              Closings whose month has no P&amp;L loaded are kept out of the figures and counted
              separately, with the origination cost already booked shown alongside &mdash; their
              loans and volume still count, because the loan did close.
            </p>
          </section>
        </div>
      </div>
    </>
  );
}

/**
 * La nomina del periodo, como lista de perfil bajo.
 *
 * ⚠ ERA UNA TABLA DE CUATRO COLUMNAS DENTRO DE UN ACORDEON DENTRO DEL PANEL, y
 * tres niveles de anidamiento para catorce numeros es lo que producia la
 * segunda barra de desplazamiento. Una lista plana dice lo mismo: cuenta,
 * importe, y el total abajo.
 */
function BloqueNomina({ rows, fragiles }: { rows: PayrollRow[]; fragiles: PayrollRow[] }) {
  if (rows.length === 0 && fragiles.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-[11px] italic text-gray-400">
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
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const fragilTotal = fragiles.reduce((s, r) => s + r.amount, 0);

  return (
    <div className="flex h-full max-h-full flex-col rounded-lg border border-slate-200 bg-slate-50 p-3">
      <dl className="min-h-0 flex-1 space-y-0.5 overflow-y-auto text-[11px]">
        {[...porCuenta.entries()].sort((a, b) => a[1].total - b[1].total).map(([gl, v]) => (
          <div key={gl} className="flex items-baseline gap-2">
            <dt className="shrink-0 text-gray-600">{v.nombre || gl}</dt>
            {/* La guia de puntos ata el nombre con su importe sin una regla ni
                una columna: a este tamaño, una tabla de cuatro columnas para
                dos datos pesa mas que el dato. */}
            <span aria-hidden className="min-w-0 flex-1 translate-y-[-3px] border-b border-dotted border-slate-300" />
            <dd className="shrink-0 font-mono tabular-nums text-gray-700">{usdExacto(v.total)}</dd>
          </div>
        ))}
      </dl>

      {/* shrink-0: el total no entra en el scroll. Ver la nota del panel. */}
      <div className="mt-2 flex shrink-0 items-baseline justify-between gap-2 border-t border-slate-200 pt-2">
        <span className="text-[11px] font-semibold text-gray-700">Total payroll cost</span>
        <span className="font-mono tabular-nums text-xs font-bold text-rose-600">{usdExacto(total)}</span>
      </div>

      {fragiles.length > 0 && (
        /*
         * Fuera del total y dicho. Si no se enseñara, estas personas caerian en
         * "no payroll located", y eso seria FALSO -- y falso de la peor manera,
         * porque se leeria como un hallazgo.
         */
        <p className="mt-2 shrink-0 text-[10px] leading-snug text-slate-500">
          {fragiles.length} more row{fragiles.length !== 1 ? "s" : ""} worth {usdExacto(fragilTotal)}{" "}
          matched with low confidence and are <span className="font-medium">not</span> in this total.
        </p>
      )}
    </div>
  );
}

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
 * ⚠ Y EL PANEL NO TIENE BARRA PROPIA. Tenia dos en paralelo --la suya y la de
 * la tabla de dentro-- y con dos, arrastrar una mueve lo que no se queria
 * mover. Se fija al alto de la ventana y SOLO la lista de prestamos scrollea:
 * la cabecera arriba y el resumen abajo se quedan siempre a la vista, que es
 * donde estan las dos cifras por las que se abre el panel.
 *
 * ⚠ z-[60]/z-[70] Y NO z-40/z-50 A PROPOSITO: esta vista vive TAMBIEN dentro
 * del modal de P&L por sucursal, que ocupa esos dos niveles. Con los mismos, el
 * panel se abriria DEBAJO del modal que lo contiene -- invisible, y sin que
 * nada pareciera roto.
 */
/**
 * ─────────────────────────────────────────────────────────────────────────────
 * UNA TABLA DE CUENTAS, REPARTIDA POR PELDAÑO
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * La usan las dos tarjetas --la de cada prestamo y la que totaliza-- porque son
 * la MISMA estructura con distinto contenido. Dos copias se habrian separado:
 * es exactamente el patron que este modulo lleva desmontando desde el principio.
 *
 * ⚠ FILAS CRUDAS EN LA TARJETA DE UN PRESTAMO, SUMADAS EN LA QUE TOTALIZA, y
 * la diferencia no es una incoherencia. Dentro de un prestamo, agrupar por
 * cuenta esconde pares que se anulan --590.857,86 en 727 grupos, 317 de ellos
 * compensandose-- y ver el par es la mitad de por que existe el desglose. En la
 * tarjeta que suma 64 prestamos, en cambio, la fila cruda no significa nada:
 * ahi lo que se quiere es cuanto pesa cada cuenta.
 */
function TablaCuentas({ lineas, sucursalPrestamo }: {
  lineas: LoanLine[]; sucursalPrestamo: string | null;
}) {
  const porEscalon = new Map<string, LoanLine[]>();
  for (const x of lineas) {
    const k = escalonDe(x.category_6);
    porEscalon.set(k, [...(porEscalon.get(k) ?? []), x]);
  }
  for (const v of porEscalon.values()) v.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  return (
    <>
      {ESCALONES.map((esc) => {
        const filas = porEscalon.get(esc.key) ?? [];
        // El escalon "other" solo aparece cuando tiene algo: un renglon
        // permanente a cero en 481 de 482 prestamos es ruido.
        if (filas.length === 0) return null;
        const subtotal = filas.reduce((s, x) => s + x.amount, 0);
        return (
          <Fragment key={esc.key}>
            <tr className="border-t border-slate-200 bg-slate-50/80">
              <td className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-600" colSpan={4}>
                <span title={esc.hint} className="cursor-help">{esc.label}</span>
              </td>
              <td className={`px-2 py-1 text-right font-mono tabular-nums font-semibold ${colorNeto(subtotal)}`}>
                {usdExacto(subtotal)}
              </td>
            </tr>
            {filas.map((x, i) => {
              /*
               * ⚠ LA SUCURSAL DEL APUNTE EN NEUTRO, NO EN AMBAR. 1.999 de 5.536
               * lineas --el 36,1%-- se contabilizan en otra sucursal, parte del
               * margen va a la 700 por diseño, y en ambar un tercio de cada
               * tarjeta pareceria un problema. Es informacion.
               */
              const otra = !!x.branch && !!sucursalPrestamo && x.branch !== sucursalPrestamo;
              return (
                <tr key={`${esc.key}-${i}`} className="border-t border-slate-100">
                  <td className="whitespace-nowrap px-2 py-0.5 pl-4 font-mono text-slate-500">{x.gl_code ?? "—"}</td>
                  <td className="whitespace-nowrap px-2 py-0.5 text-slate-700" title={x.check_description ?? undefined}>
                    {x.gl_name ?? "—"}
                  </td>
                  <td className="whitespace-nowrap px-2 py-0.5 text-slate-400">{x.category_7 ?? "—"}</td>
                  <td className="whitespace-nowrap px-2 py-0.5">
                    <span className={otra
                      ? "rounded border border-slate-300 bg-white px-1 font-mono text-slate-600"
                      : "font-mono text-slate-400"}
                      title={otra ? `Booked in branch ${x.branch}, while the loan is branch ${sucursalPrestamo}. Common and not an error: part of the margin is booked in 700 by design.` : undefined}>
                      {x.branch ?? "—"}
                    </span>
                  </td>
                  <td className={`whitespace-nowrap px-2 py-0.5 text-right font-mono tabular-nums ${
                    x.amount < 0 ? "text-red-600" : "text-slate-700"
                  }`}>
                    {usdExacto(x.amount)}
                  </td>
                </tr>
              );
            })}
          </Fragment>
        );
      })}
    </>
  );
}

/**
 * Lo que no se queda la sucursal, debajo del total y fuera de la cuenta.
 *
 * ⚠ DESPUES DEL TOTAL, NUNCA ANTES NI INTERCALADO. La sucursal cierra su cuenta
 * en Total contribution; lo de corporativo es contexto. Puesto en medio parece
 * que participa en la resta. Y la etiqueta lo dice UNA VEZ, en su cabecera.
 */
function FueraDeLaCuenta({ lineas, sucursalPrestamo }: {
  lineas: LoanLine[]; sucursalPrestamo: string | null;
}) {
  const fuera = lineas.filter((x) => !x.in_branch);
  if (fuera.length === 0) return null;

  return (
    <div className="mt-2 border-t-2 border-slate-300 pt-2">
      <p className="px-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
        Not part of this branch&rsquo;s contribution
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] text-[11px]">
          <tbody>
            {DESTINOS.map((d) => {
              const suyas = fuera
                .filter((x) => d.suyo(x, { branch: sucursalPrestamo } as LoanRow))
                .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
              // La linea a cero no se enseña: diria que se miro y no habia,
              // cuando lo que hay que decir es lo que si hay.
              if (suyas.length === 0) return null;
              return (
                <Fragment key={d.key}>
                  <tr>
                    <td className="px-2 py-1 text-slate-500" colSpan={4}>{d.label}</td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums text-slate-500">
                      {usdExacto(suyas.reduce((s, x) => s + x.amount, 0))}
                    </td>
                  </tr>
                  {suyas.map((x, i) => (
                    <tr key={`${d.key}-${i}`} className="text-slate-400">
                      <td className="whitespace-nowrap px-2 py-0.5 pl-4 font-mono">{x.gl_code ?? "—"}</td>
                      <td className="whitespace-nowrap px-2 py-0.5" title={x.check_description ?? undefined}>{x.gl_name ?? "—"}</td>
                      <td className="whitespace-nowrap px-2 py-0.5">{x.category_7 ?? "—"}</td>
                      <td className="whitespace-nowrap px-2 py-0.5 font-mono">{x.branch ?? "—"}</td>
                      <td className="whitespace-nowrap px-2 py-0.5 text-right font-mono tabular-nums">{usdExacto(x.amount)}</td>
                    </tr>
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** El cierre de la escalera: la comision y el total, iguales en las dos tarjetas. */
function CierreEscalera({ commission, contribution }: {
  commission: number | null; contribution: number | null;
}) {
  return (
    <>
      <tr className="border-t border-slate-200 bg-slate-50/80">
        <td className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-600" colSpan={4}>
          &minus; LO commission
          <span className="ml-1.5 font-normal normal-case tracking-normal text-slate-400">
            from Compensafe — not a P&amp;L account
          </span>
        </td>
        <td className="px-2 py-1 text-right font-mono tabular-nums font-semibold text-red-600">
          {commission == null
            ? <span className="text-slate-400" title="This loan does not cross with Compensafe. Not the same as a zero commission.">not known</span>
            : usdExacto(-commission)}
        </td>
      </tr>
      <tr className="border-t-2 border-slate-400 bg-slate-50">
        <td className="px-2 py-1.5 text-[11px] font-bold uppercase tracking-wide text-[#001A40]" colSpan={4}>
          = Total contribution
        </td>
        <td className={`px-2 py-1.5 text-right font-mono tabular-nums text-sm font-bold ${colorNeto(contribution ?? 0)}`}>
          {contribution == null ? "—" : usdExacto(contribution)}
        </td>
      </tr>
    </>
  );
}

/**
 * La tarjeta de UN prestamo.
 *
 * ⚠ ES EL MISMO COMPONENTE QUE PINTA EL MINI P&L DEL MODAL DE SUCURSAL,
 * `LoanPnlCard`, y no uno parecido. Dos tarjetas parecidas divergen: el neto de
 * Table List y el de las Mini P&L Cards ya dieron cifras distintas con nombres
 * parecidos, sin que nada fallara.
 *
 * Lo que esta pantalla le pasa de mas:
 *   - `commission`, porque aqui la pregunta es que dejo el prestamo DESPUES de
 *     pagar al loan officer. El mini P&L no la pasa, y por eso su banner dice
 *     TOTAL REVENUE y este TOTAL CONTRIBUTION.
 *   - `elsewhere`, la seccion de la 700, que solo existe aqui porque solo aqui
 *     el revenue se restringe a la sucursal del prestamo.
 *
 * ⚠ PLEGABLE, y el envoltorio es de esta pantalla y no del componente: el mini
 * P&L enseña un carrusel de tarjetas siempre abiertas, y aqui Nathan Martinez
 * apila 65 con 840 filas de cuenta entre todas.
 */
function TarjetaPrestamo({ l, abierta, onToggle }: {
  l: LoanRow; abierta: boolean; onToggle: () => void;
}) {
  const propias = l.lines.filter((x) => x.in_branch);
  const fuera700 = l.lines.filter((x) => !x.in_branch && x.branch === "700");
  const fueraOtra = l.lines.filter((x) => !x.in_branch && x.branch !== "700");

  if (!abierta) {
    /*
     * Plegada enseña lo mismo que la cabecera de la tarjeta abierta: numero,
     * prestatario, periodo, importe, bps y contribucion. Plegar NO esconde
     * ninguna cifra -- solo el desglose por cuenta.
     */
    return (
      <button
        onClick={onToggle}
        className="flex w-[340px] shrink-0 items-center justify-between gap-2 rounded-2xl border border-slate-200/90 bg-white px-3.5 py-2.5 text-left shadow-xs hover:border-[#A6DEFF]"
      >
        <span className="min-w-0">
          <span className="block truncate font-mono text-xs font-bold text-[#001A40]">{l.loan_number}</span>
          <span className="block truncate text-[10px] text-slate-500">
            {l.borrower_name ?? "—"} · {l.month} {l.year} · {usd(l.loan_amount)}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className={`block font-mono tabular-nums text-xs font-bold ${colorNeto(l.contribution ?? 0)}`}>
            {l.contribution == null ? "—" : usd(l.contribution)}
          </span>
          <span className="block font-mono text-[10px] text-slate-400">{bps(l.contribution, l.loan_amount)} bps</span>
        </span>
      </button>
    );
  }

  return (
    <div onClick={onToggle} className="cursor-pointer">
      <LoanPnlCard
        loan_number={l.loan_number}
        branch={l.branch}
        borrower_name={l.borrower_name}
        loan_program={l.loan_program}
        loan_officer={l.loan_officer}
        loan_amount={l.loan_amount}
        b2b={l.b2b}
        processing={l.processing}
        support_on_demand={l.support_on_demand}
        signals={
          <>
            <span className="rounded-full border border-slate-200 bg-white px-1.5 py-0.5 text-[9px] font-semibold text-slate-500">
              {l.month} {l.year}
            </span>
            {l.plPending && (
              <span title="No P&L is loaded for this loan's closing month. Left out of the totals; its origination cost may already be booked."
                    className="ml-1 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[9px] font-bold text-amber-700">
                pending P&amp;L
              </span>
            )}
            {l.branchNotInPl && (
              <span title={`Branch ${l.branch} carries no entries at all in the P&L, so none of this loan's revenue can be booked to it.`}
                    className="ml-1 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[9px] font-bold text-amber-700">
                branch not in P&amp;L
              </span>
            )}
          </>
        }
        lineas={propias}
        commission={l.commission}
        total={{ label: "TOTAL CONTRIBUTION", value: l.contribution }}
        elsewhere={[
          { label: "Kept by the division (700)", lineas: fuera700 },
          { label: "Booked in another branch", lineas: fueraOtra },
        ]}
      />
    </div>
  );
}

/**
 * La tarjeta que totaliza: la MISMA estructura, sumando todos sus prestamos.
 *
 * Y lo unico que solo puede estar aqui: la nomina, que no cuelga de ningun
 * prestamo, y las dos cifras que hay que poder ver juntas -- lo que generaron
 * sus cierres contra lo que el P&L registra pagado.
 */
function TarjetaTotales({ o }: { o: OfficerBlock }) {
  /*
   * ─────────────────────────────────────────────────────────────────────────
   * ⚠ AQUI SE AGRUPA Y EN LA TARJETA DE UN PRESTAMO NO. PARECE UNA
   *   CONTRADICCION Y NO LO ES.
   * ─────────────────────────────────────────────────────────────────────────
   *
   * La fila cruda existe para que se vea un par anularse DENTRO de un prestamo:
   * 41305 LO Margin -9.602,39 contra 41200 Discount Income +9.602,39, o los
   * +389,00 y -333,00 de 41205 que son un traslado a la 700. Ahi la fila cruda
   * es el dato.
   *
   * Sumando los 64 prestamos de Nathan Martinez serian 840 filas, y ninguna
   * diria nada: un +389,00 suelto entre ochocientas no es informacion, es
   * ruido. Lo que se pregunta en esta tarjeta es otra cosa --cuanto pesa cada
   * cuenta en el total-- y para eso la suma es la respuesta.
   *
   * Dos preguntas distintas sobre los mismos datos, como las dos cuentas del
   * pie. El criterio no es "crudo o agrupado", es "¿que se esta preguntando?".
   */
  const agrupadas = useMemo(() => {
    const m = new Map<string, LoanLine>();
    for (const l of o.loans) {
      for (const x of l.lines) {
        const k = `${x.gl_code}|${x.branch}|${x.category_6}|${x.in_branch}`;
        const e = m.get(k);
        if (e) e.amount += x.amount;
        else m.set(k, { ...x, check_description: null });
      }
    }
    return [...m.values()];
  }, [o.loans]);

  const nominaPos = -o.block2Total;
  const localizada = o.payrollStatus !== "not_located";

  return (
    <article className="rounded-xl border-2 border-[#001A40]/25 bg-white shadow-sm">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-t-xl border-b border-slate-200 bg-[#001A40] px-3 py-2 text-white">
        <span className="text-xs font-semibold uppercase tracking-wide">
          All {o.loanCount} closing{o.loanCount === 1 ? "" : "s"}
        </span>
        <div className="flex items-baseline gap-4 text-[11px]">
          <span className="font-mono tabular-nums text-white/60">{usd(o.volume)}</span>
          <span className="font-mono tabular-nums text-white/60">{bps(o.contribution, o.volume)} bps</span>
          <span className={`font-mono tabular-nums text-xs font-bold ${
            o.contribution > 0 ? "text-emerald-300" : o.contribution < 0 ? "text-red-300" : "text-white/70"
          }`}>
            {usd(o.contribution)}
          </span>
        </div>
      </header>

      <div className="px-1 py-1">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-[11px]">
            <tbody>
              <TablaCuentas lineas={agrupadas.filter((x) => x.in_branch)} sucursalPrestamo={null} />
              <CierreEscalera commission={o.commission} contribution={o.contribution} />
            </tbody>
          </table>
        </div>
        <FueraDeLaCuenta lineas={agrupadas} sucursalPrestamo={null} />
      </div>

      {/* ── Lo que no cuelga de ningun prestamo ───────────────────────────── */}
      <div className="border-t-2 border-slate-200 px-3 py-3">
        <h4 className="pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Payroll this period
        </h4>
        <BloqueNomina rows={o.payroll} fragiles={o.payrollFragile} />

        {/*
          * ⚠ LAS DOS CIFRAS, JUNTAS Y CON SU DIFERENCIA. Alguien las va a
          * comparar de todas formas; ensenadas juntas con la explicacion al
          * lado no invitan a restarlas, y ausentes si.
          *
          * Son dos calendarios: Compensafe agrupa por FECHA DE CIERRE y el P&L
          * por FECHA DE PAGO, asi que no tienen por que cuadrar.
          */}
        <dl className="mt-2 space-y-1 rounded-lg border border-slate-200 bg-white p-3 text-[11px]">
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-slate-600">Commission on loans</dt>
            <dd className="font-mono tabular-nums text-slate-700">{usdExacto(o.commission)}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-slate-600">Actually paid in payroll</dt>
            <dd className="font-mono tabular-nums text-slate-700">
              {localizada ? usdExacto(nominaPos) : (
                <span className="text-amber-600" title="No payroll row anywhere in the P&L carries this name. This is an absence, not a zero.">
                  not located
                </span>
              )}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 border-t border-slate-200 pt-1">
            <dt className="font-medium text-slate-600">Difference</dt>
            <dd className="font-mono tabular-nums font-medium text-slate-700">
              {localizada ? usdExacto(o.commission - nominaPos) : "—"}
            </dd>
          </div>
        </dl>

        {/*
          * ⚠ EL NETO NO SALE DE LA CONTRIBUCION, y encadenarlos es el error que
          * mas caro sale aqui porque el resultado parece razonable: la comision
          * se PAGA POR LA NOMINA, asi que restarla en la escalera y ademas
          * restar la nomina entera resta el mismo dinero dos veces --
          * 1.163.656,81 dentro de una nomina de 5.362.891,98, el 21,7%.
          */}
        <dl className="mt-2 space-y-1 rounded-lg bg-[#001A40] p-3 text-[11px] text-white">
          <p className="pb-1 text-[10px] uppercase tracking-wide text-white/40">
            Does this person pay for themselves — a separate question
          </p>
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-white/70">Produced</dt>
            <dd className="font-mono tabular-nums">{usdExacto(o.produced)}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-white/70">&minus; Payroll not tied to loans</dt>
            <dd className="font-mono tabular-nums">
              {localizada ? usdExacto(nominaPos) : <span className="text-amber-300">not located</span>}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 border-t border-white/25 pt-1.5">
            <dt className="font-semibold uppercase tracking-wide">= Net</dt>
            <dd className={`font-mono tabular-nums text-sm font-bold ${
              o.total > 0 ? "text-emerald-300" : o.total < 0 ? "text-red-300" : "text-white/70"
            }`}>
              {usdExacto(o.total)}
            </dd>
          </div>
        </dl>
      </div>
    </article>
  );
}
/**
 * ─────────────────────────────────────────────────────────────────────────────
 * EL DETALLE DE UNA PERSONA, EN TARJETAS APILADAS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ UN SOLO SCROLL, EL DEL PANEL. Antes habia tres cajas de alto fijo peleandose
 * por el hueco --lista de prestamos, nomina, resumen-- y cada una con su barra;
 * arrastrar una movia lo que no se queria mover. Ahora las tarjetas se apilan y
 * el panel crece: solo scrollea el, como una pagina.
 *
 * ⚠ EL HORIZONTAL SI SE ACEPTA, dentro de cada tabla de cuentas. Cinco columnas
 * --gl, nombre, category_7, sucursal, importe-- no caben siempre, y la
 * alternativa era recortar el nombre de la cuenta hasta hacerlo inutil.
 *
 * ⚠ z-[60]/z-[70] Y NO z-40/z-50 A PROPOSITO: esta vista vive TAMBIEN dentro
 * del modal de P&L por sucursal, que ocupa esos dos niveles. Con los mismos, el
 * panel se abriria DEBAJO del modal que lo contiene -- invisible, y sin que
 * nada pareciera roto.
 */
function PanelDetalle({ o, onClose }: { o: OfficerBlock; onClose: () => void }) {
  const [ayuda, setAyuda] = useState(false);

  /*
   * ─────────────────────────────────────────────────────────────────────────
   * PLEGADAS A PARTIR DE 15 CIERRES, ABIERTAS POR DEBAJO
   * ─────────────────────────────────────────────────────────────────────────
   *
   * Medido en el peor caso, Nathan Martinez: 64 de sus 65 cierres tienen
   * lineas, 840 filas de cuenta en total --13,9 de media y 28 en el peor
   * prestamo--, o sea mas de mil filas apiladas de una vez.
   *
   * ⚠ PLEGAR AQUI NO ESCONDE NINGUNA CIFRA, y es lo que hace que esta sea la
   * salida buena y no las otras dos. La cabecera de cada tarjeta lleva ya
   * numero, prestatario, periodo, importe, bps y contribucion: lo unico que se
   * pliega es el desglose por cuenta. Paginar o enseñar "los N mayores" SI
   * esconderia dinero, y este modulo no puede hacer eso.
   *
   * El umbral va por numero de cierres y no por filas porque es lo que el
   * lector ve antes de abrir: con doce prestamos quiere el detalle, con sesenta
   * y cinco quiere primero la lista.
   */
  const UMBRAL_PLEGADO = 15;
  const [plegadas, setPlegadas] = useState<Set<string>>(
    () => new Set(o.loans.length > UMBRAL_PLEGADO ? o.loans.map((l) => l.loan_number) : []),
  );
  const alternar = (ln: string) =>
    setPlegadas((prev) => {
      const n = new Set(prev);
      if (n.has(ln)) n.delete(ln); else n.add(ln);
      return n;
    });
  const todasPlegadas = o.loans.length > 0 && plegadas.size === o.loans.length;

  // Escape cierra. Un panel que solo se cierra con la X se queda abierto en
  // cuanto alguien lo intenta por el camino de siempre.
  useEffect(() => {
    const alPulsar = (e: KeyboardEvent) => {
      // Con la ayuda abierta, Escape la cierra a ella y no al panel entero:
      // cerrar los dos de un golpe pierde el sitio donde se estaba mirando.
      if (e.key === "Escape" && !ayuda) onClose();
    };
    window.addEventListener("keydown", alPulsar);
    return () => window.removeEventListener("keydown", alPulsar);
  }, [onClose, ayuda]);

  return (
    <>
      <div className="fixed inset-0 z-[60] bg-slate-900/25" onClick={onClose} />
      <aside
        role="dialog"
        aria-label={`Detail for ${o.name}`}
        className="fixed inset-y-0 right-0 z-[70] w-full max-w-6xl overflow-y-auto border-l border-slate-200 bg-slate-50 shadow-2xl"
      >
        {/*
          * La cabecera se fija: con 65 tarjetas, bajar hasta la ultima dejaba
          * sin referencia de quien se estaba mirando y sin manera de cerrar sin
          * volver arriba.
          */}
        <header className="sticky top-0 z-10 flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 bg-white px-5 py-3 shadow-sm">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-[#001A40]">{o.name}</h3>
            <p className="mt-0.5 truncate text-[11px] text-slate-500">
              {o.position ?? "Role not in the HR roster"}
              {o.area ? ` · ${o.area}` : ""}
              {o.branch ? ` · branch ${o.branch}` : ""}
              {o.loansPendingPl > 0 && (
                <span className="ml-2 text-amber-700"
                      title={`${usdExacto(Math.abs(o.pendingPlBooked))} of origination cost is already booked on them; the margin is not. Left out of the figures.`}>
                  · {o.loansPendingPl} pending P&amp;L
                </span>
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {/*
              * ⚠ LOS DOS BOTONES A LA VISTA, no uno que cambia de texto. Con
              * uno solo, el que aparece depende de un estado que no se ve --si
              * estan todas plegadas o no-- y con 65 tarjetas eso no se sabe sin
              * bajar hasta el final. Dos botones dicen las dos acciones
              * posibles, y el que ya no hace nada se apaga.
              */}
            {o.loans.length > 1 && (
              <span className="mr-1 inline-flex overflow-hidden rounded-full border border-slate-200 text-[10px]">
                <button
                  onClick={() => setPlegadas(new Set())}
                  disabled={plegadas.size === 0}
                  className="px-2.5 py-1 text-slate-500 enabled:hover:bg-slate-50 disabled:text-slate-300"
                >
                  Expand all
                </button>
                <button
                  onClick={() => setPlegadas(new Set(o.loans.map((l) => l.loan_number)))}
                  disabled={todasPlegadas}
                  className="border-l border-slate-200 px-2.5 py-1 text-slate-500 enabled:hover:bg-slate-50 disabled:text-slate-300"
                >
                  Collapse all
                </button>
              </span>
            )}
            {/*
              * ⚠ UN SOLO BOTON PARA TODA LA PROSA. Los parrafos estaban
              * repartidos entre las tarjetas y eran lo que impedia leer una
              * columna de arriba abajo sin cruzar texto.
              */}
            <button
              onClick={() => setAyuda(true)}
              className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-2.5 py-1 text-[10px] text-slate-500 hover:bg-slate-50"
            >
              <Info size={11} />
              How this P&amp;L is calculated
            </button>
            <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100" aria-label="Close">
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="space-y-3 px-5 py-4">
          {/* La que totaliza, primero: la respuesta antes que el detalle. */}
          <TarjetaTotales o={o} />

          {o.loans.length > 0 && (
            <p className="px-1 pt-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              One card per closing
            </p>
          )}
          {o.loans.map((l) => (
            <TarjetaPrestamo
              key={l.loan_number}
              l={l}
              abierta={!plegadas.has(l.loan_number)}
              onToggle={() => alternar(l.loan_number)}
            />
          ))}
        </div>
      </aside>

      {ayuda && <AyudaPnl onClose={() => setAyuda(false)} />}
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
    division: officers.reduce((s, o) => s + o.block1KeptByDivision, 0),
    otraSucursal: officers.reduce((s, o) => s + o.block1OtherBranch, 0),
    coste: officers.reduce((s, o) => s + o.block2Total, 0),
    neto: officers.reduce((s, o) => s + o.total, 0),
  }), [officers]);

  const personaAbierta = abierto
    ? officers.find((o) => (o.personCode ?? o.name) === abierto) ?? null
    : null;

  const sinNomina = officers.filter((o) => o.payrollStatus === "not_located" && o.loanCount > 0);
  const sucursalFantasma = officers.filter((o) => o.loansBranchNotInPl > 0);
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
              Only what the loan&rsquo;s own branch books.
            </span>{" "}
            A loan&rsquo;s revenue is not all booked in the branch that produced it. Those lines
            are real and they are shown &mdash; open any loan and they sit below its total, under
            &ldquo;Not part of this branch&rsquo;s contribution&rdquo; &mdash; but they are not
            counted in any column here. Across the division that is{" "}
            {usdExacto(Math.abs(totales.division))} kept by the division in 700, which is the
            normal split, and {usdExacto(Math.abs(totales.otraSucursal))} booked in a third
            branch, which is not. Branch &ldquo;Affinity&rdquo; is read as 716, where its loans
            are booked.
          </p>
          {/*
            * ⚠ EL AVISO DE COMPENSAFE ES EL QUE EVITA LA LLAMADA. Alguien va a
            * comparar "Produced" contra lo que Compensafe dice que genero esa
            * persona, no va a cuadrar, y va a suponer que la pantalla esta
            * rota. Dicho aqui, la diferencia es una respuesta y no un fallo.
            */}
          <p>
            <span className="font-semibold text-gray-700">
              &ldquo;Produced&rdquo; is not everything they generated.
            </span>{" "}
            It is what the loan&rsquo;s own branch booked. Compared against Compensafe, or against
            a loan officer&rsquo;s own production report, it will come out lower &mdash; and the
            gap is what other branches book &mdash; mostly division margin sitting in
            700. Neither number is wrong; they answer different questions.
          </p>
          {/*
            * ⚠ "SU SUCURSAL NO ESTA EN LOS LIBROS", NO "no produjeron". La
            * distincion es toda la diferencia y sin decirla la pantalla las
            * enseña igual: nueve cierres con gross revenue cero que parecen
            * nueve prestamos que no dejaron nada.
            */}
          {sucursalFantasma.length > 0 && (
            <p>
              <span className="font-semibold text-amber-700">
                Two branches are not in the P&amp;L at all.
              </span>{" "}
              {sucursalFantasma.map((o) => `${o.name} (${o.loansBranchNotInPl})`).join(", ")}
              {" "}&mdash; {sucursalFantasma.reduce((s, o) => s + o.loansBranchNotInPl, 0)} closings
              whose branch carries no entries in the ledger, so they cannot show revenue of their
              own. Theirs is booked in 700 and 733 instead. It is the same situation the
              &ldquo;Affinity&rdquo; alias exists to fix, but their revenue splits across two
              branches, so picking one would move money between branches on a hunch &mdash; a
              question for whoever maintains the branch catalogue, not something this screen
              should guess.
            </p>
          )}
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
                  <th className="px-3 py-2 font-medium text-right" title="Appraisal, credit report, verification — and branch-to-branch transfers (55601), which is why this line can be unusually large on a single loan. Shown with its own sign: these usually ADD, because they are charged to the borrower and come back to the branch.">
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
                          {/*
                            * ⚠ "SU SUCURSAL NO ESTA EN LOS LIBROS", NO "no
                            * produjo". Sin esta marca, los siete cierres de
                            * Silvio Arteaga en la 776 se leen como siete
                            * prestamos que no dejaron nada, cuando lo que pasa
                            * es que la 776 no tiene ni una linea en el P&L.
                            */}
                          {o.loansBranchNotInPl > 0 && (
                            <Marca tono="ambar"
                              title="Their branch has no entries at all in the P&L, so these loans cannot show revenue of their own — it is booked in other branches. Not the same as having earned nothing.">
                              {o.loansBranchNotInPl} closing{o.loansBranchNotInPl === 1 ? "" : "s"} in a branch the P&amp;L does not carry
                            </Marca>
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
                  <td className="px-3 py-2 text-right">{usd(totales.revenue)}</td>
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
