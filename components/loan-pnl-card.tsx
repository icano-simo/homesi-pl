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
   * ⚠ VAN DESPUES DEL BANNER, NO DENTRO DE LOS PELDAÑOS. Estuvieron dentro y
   * con el mismo estilo de bloque, y entonces la tarjeta se leia como si el
   * total fuera revenue menos costes menos comision MENOS NOMINA. La nomina no
   * entra: es el sueldo de la persona, no cuelga de ningun prestamo, y la
   * comision se paga A TRAVES de ella -- restar las dos contaria dos veces el
   * mismo dinero.
   *
   * Comparten sitio y fondo con la seccion de la 700 porque son lo mismo:
   * contexto detras del total, no parte de la resta.
   */
  extra?: React.ReactNode;
  /**
   * Si se pasa, la ficha lleva un chevron que pliega la tarjeta.
   *
   * ⚠ SOLO EL CHEVRON, no la tarjeta entera. Envolviendola en un onClick,
   * pulsar cualquier cifra la escondia -- y en una tarjeta que existe para
   * poder señalar cifras, eso es lo contrario de lo que se espera.
   */
  onCollapse?: () => void;
  /**
   * La tarjeta que SUMA, no una de la fila.
   *
   * ⚠ SE DISTINGUE A LA VISTA, no solo por el titulo. Es la primera de una fila
   * de sesenta y cinco iguales, y leida al vuelo parecia una mas: un borde y
   * una sombra distintos evitan tener que leer la cabecera para saber cual
   * responde por el conjunto.
   */
  esTotal?: boolean;
}

/**
 * ⚠ EL DINERO VA SIN DECIMALES Y LOS bps CON UNO, y no es una inconsistencia:
 * es donde cada cifra tiene su precision util. En una tarjeta con veinte lineas,
 * los centimos son veinte pares de digitos que nadie lee y que descuadran la
 * columna; en los bps el decimal SI dice algo --180,0 contra 179,6 son dos
 * rendimientos distintos-- porque ahi el numero entero es demasiado grueso.
 *
 * El desglose al centimo sigue existiendo donde hace falta cuadrar contra la
 * contabilidad: el tooltip de cada linea lleva su descripcion, y la tabla de
 * fuera conserva sus cifras.
 */
export const usdEntero = (n: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);

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
  { key: "other", label: "Other cost", grupo: null },
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
      {/*
        * ⚠ ANCHO FIJO EN LAS DOS CIFRAS, no solo alineadas a la derecha. Con el
        * ancho del contenido, "9.602,39" y "-71,76" acaban en el mismo borde
        * pero sus comas caen en columnas distintas, y entonces la columna no se
        * puede recorrer de un vistazo -- que es para lo que existe `tabular-nums`.
        * Con el ancho fijo, los decimales quedan en la misma vertical en todas
        * las filas de todas las tarjetas.
        */}
      <span
        title={x.check_description ?? (x.amount > 0 ? "Adds to the net" : x.amount < 0 ? "Takes from the net" : "No amount")}
        className="flex shrink-0 items-baseline gap-1.5 font-mono tabular-nums text-[11px]"
      >
        <span className={`w-[5.5rem] text-right ${colorImporte(x.amount)}`}>{usdEntero(x.amount)}</span>
        <span className="w-[4rem] text-right font-normal text-slate-400">{bps(x.amount, importeBase)}</span>
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
    <div className={`flex w-[340px] shrink-0 flex-col overflow-hidden rounded-2xl transition-all ${
      p.esTotal
        ? "border-2 border-[#001A40] bg-white shadow-lg ring-4 ring-[#001A40]/10"
        : "border border-slate-200/90 bg-white shadow-xs hover:border-[#A6DEFF]"
    }`}>
      {/*
        * ⚠ SIN flex-1 AQUI. Lo tenia, y como la fila estira todas las tarjetas
        * al alto de la mas alta, ese flex-1 se comia el sobrante y CLAVABA el
        * banner al fondo: en la tarjeta de totales, que es mas corta, quedaba un
        * hueco entre la nomina y el TOTAL CONTRIBUTION.
        *
        * Ahora el banner va pegado al ultimo bloque y el hueco cae DEBAJO de
        * todo, en el separador del final.
        */}
      <div className="flex flex-col">
        {/*
          * ── La ficha ─────────────────────────────────────────────────────
          *
          * ⚠ TODO LO DE AQUI TIENE DOS VERSIONES, CLARA Y OSCURA, y no es
          * decoracion: al poner la ficha de la tarjeta de totales en negativo,
          * cada estilo heredado que asumia fondo claro se rompio EN SILENCIO --
          * no fallan, solo se ven mal, asi que ningun typecheck ni ningun build
          * los ve. Encontrados cinco al revisarla entera:
          *
          *   chevron    slate-400 sobre navy, y un `hover:bg-white` que dejaba
          *              una caja blanca alrededor del icono
          *   tag        `bg-white` heredando `text-white` del contenedor:
          *              blanco sobre blanco, o sea INVISIBLE -- el peor de los
          *              cinco y el que no se reporto
          *   subtitle   slate-600 sobre navy
          *   meta       slate-500 sobre navy
          *   importe    slate-500 sobre navy
          *
          * Los avisos (`signals`) los pinta quien usa la tarjeta, asi que su
          * version oscura vive en TarjetaTotales.
          */}
        <div className={`flex shrink-0 flex-col gap-1 border-b p-3.5 text-xs font-bold ${
          p.esTotal ? "border-white/15 bg-[#001A40] text-white" : "border-slate-200 bg-slate-100/90 text-[#001A40]"
        }`}>
          <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1">
              {p.onCollapse && (
                <button
                  onClick={p.onCollapse}
                  title="Collapse this card"
                  className={`shrink-0 rounded p-0.5 ${
                    p.esTotal
                      ? "text-white/60 hover:bg-white/15 hover:text-white"
                      : "text-slate-400 hover:bg-white hover:text-slate-600"
                  }`}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>
              )}
              <span className="truncate font-mono">{p.title}</span>
            </span>
            {p.tag && (
              <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] ${
                p.esTotal ? "bg-white/15 text-white" : "bg-white text-[#001A40]"
              }`}>
                {p.tag}
              </span>
            )}
          </div>
          <span className={`truncate font-semibold ${p.esTotal ? "text-white/90" : "text-slate-600"}`}>
            {p.subtitle ?? "—"}
          </span>
          {/* Identidad, no dato: contesta "de quien es esto y de que tipo" antes
              que ninguna cifra. */}
          <span className={`truncate text-[10px] font-normal ${p.esTotal ? "text-white/55" : "text-slate-500"}`}>
            {p.meta ?? "—"}
          </span>
          <div className="flex items-center justify-between gap-2">
            <span className={`font-mono tabular-nums ${p.esTotal ? "text-white/70" : "text-slate-500"}`}>
              {p.amount == null ? "—" : `$${p.amount.toLocaleString("en-US", { maximumFractionDigits: 0 })}`}
            </span>
            <span className="inline-flex items-center gap-0.5">
              {p.b2b && <Etiqueta label="B2B" oscuro={p.esTotal} />}
              {p.support_on_demand && <Etiqueta label="On Demand" oscuro={p.esTotal} />}
              {p.processing && <Etiqueta label="Processing" oscuro={p.esTotal} />}
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
                {/*
                  * ⚠ UNA LINEA CON REGLA, NO UNA CAJA. Eran cajas con fondo y
                  * borde que ocupaban dos renglones, y con tres peldaños por
                  * tarjeta la caja pesaba mas que la cifra que anunciaba: lo
                  * que se venia a leer --el subtotal-- quedaba subordinado al
                  * marco que lo rodeaba.
                  *
                  * La etiqueta se achica y la cifra manda, en la misma linea.
                  */}
                <div className="mt-2 flex items-baseline justify-between gap-2 border-t border-slate-200 px-3 pb-1 pt-2">
                  <span className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500">
                    {esc.label}
                  </span>
                  <span className="flex shrink-0 items-baseline gap-1.5 font-mono tabular-nums">
                    <span className={`w-[5.5rem] text-right text-xs font-bold ${
                      subtotal < 0 ? "text-rose-700" : "text-[#001A40]"
                    }`}>
                      {usdEntero(subtotal)}
                    </span>
                    <span className="w-[4rem] text-right text-[11px] font-normal text-slate-400">
                      {bps(subtotal, p.amount)}
                    </span>
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
            /* La comision comparte forma con los peldaños: es el ultimo antes
               del total, y dejarla en caja mientras los otros son linea la
               habria hecho parecer otra cosa. */
            <div className="mt-2 flex items-baseline justify-between gap-2 border-t border-slate-200 px-3 pb-1 pt-2">
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
              {/*
                * ⚠ SIN "from Compensafe" AQUI. Es cierto y hace falta decirlo,
                * pero repetido en cada tarjeta de una fila de sesenta y cinco
                * deja de leerse y ocupa el sitio del dato. Se dice UNA VEZ,
                * junto al boton de ayuda de la cabecera.
                *
                * Lo que SI se queda es que resta "Commission on loans" y no la
                * nomina: eso distingue dos cifras de la misma tarjeta y tiene
                * que estar en la linea que resta.
                */}
              <span className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500">
                &minus; Commission on loans
              </span>
              <span className="flex shrink-0 items-baseline gap-1.5 font-mono tabular-nums">
                {p.commission == null
                  ? <span className="w-[5.5rem] text-right text-xs text-slate-400" title="This loan does not cross with Compensafe. Not the same as a zero commission.">not known</span>
                  : <span className="w-[5.5rem] text-right text-xs font-bold text-rose-700">{usdEntero(-p.commission)}</span>}
                <span className="w-[4rem] text-right text-[11px] font-normal text-slate-400">
                  {p.commission == null ? "" : bps(-p.commission, p.amount)}
                </span>
              </span>
            </div>
          )}

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
      {/*
        * ⚠ UNA SOLA LINEA Y py-2. Era `p-4` con la cifra y sus bps apilados, o
        * sea tres renglones de alto para decir una cosa: la caja pesaba mas que
        * el numero. Compacta y en horizontal, la cifra sigue siendo la mayor de
        * la tarjeta sin necesitar tanto sitio.
        */}
      {/*
        * ⚠ LA CIFRA MANDA, Y ANTES NO. Estaba en blanco apagado, pequeña y
        * delgada, al lado de unos bps en azul claro que le robaban la mirada:
        * el numero mas importante de la tarjeta era el que menos se veia.
        *
        * ⚠ EL COLOR ES #A6DEFF Y NO EL VERDE, y la razon es de significado, no
        * de gusto. En este modulo el verde YA quiere decir "positivo" --lo usa
        * `colorNeto` en la tabla y en las filas-- asi que una cifra verde aqui
        * se leeria como "va bien", que es redundante: el banner ya dice eso
        * entero, poniendose rosa cuando pierde. Y en el estado de perdida el
        * verde tendria que irse, o sea que no serviria como identidad estable
        * del banner. El azul no significa polaridad en ninguna parte del
        * modulo, asi que dice "este es el total" y nada mas -- y ademas es el
        * acento que la app ya usa.
        */}
      <div
        className={`flex shrink-0 flex-col gap-0.5 px-4 py-2 shadow-xs ${
          perdida ? "border-t border-rose-200 bg-rose-100" : "bg-[#001A40]"
        }`}
      >
        <span className={`text-[10px] font-extrabold uppercase tracking-widest ${
          perdida ? "text-rose-800" : "text-slate-300"
        }`}>
          {p.total.label}
        </span>
        <span className="flex items-baseline justify-between gap-2">
          <span className={`font-mono text-xl font-extrabold leading-none tabular-nums ${
            perdida ? "text-rose-700" : "text-[#A6DEFF]"
          }`}>
            {p.total.value == null ? "—" : usdEntero(p.total.value)}
          </span>
          {/* El badge baja de tono para no competir con la cifra. */}
          <span className={`shrink-0 rounded-md border px-2 py-0.5 font-mono text-[10px] tabular-nums ${
            perdida
              ? "border-rose-300 bg-rose-200/60 text-rose-800"
              : "border-white/20 bg-white/10 text-slate-200"
          }`}>
            {p.total.value == null ? "— bps" : bps(p.total.value, p.amount)}
          </span>
        </span>
      </div>

      {/*
        * ── El orden de lo que va detras del total ───────────────────────────
        *
        * ⚠ NO ES EL MISMO EN LAS DOS TARJETAS, y se deriva de `extra` en vez de
        * pedirlo por prop: quien tiene nomina es la tarjeta que totaliza, y es
        * la unica donde el orden cambia.
        *
        *   tarjeta de PRESTAMO   total -> 700            (no hay nomina)
        *   tarjeta de TOTALES    total -> nomina -> 700
        *
        * La 700 va al FINAL en la de totales porque es lo unico que no es del
        * loan officer: metida entre el total y su nomina quedaba en medio de lo
        * suyo. En las de prestamo no hay nada detras que separarla, asi que se
        * queda pegada al total.
        */}
      {p.extra && (
        /*
         * ⚠ LO QUE NO ENTRA EN EL TOTAL. Estuvo ANTES del banner y con el mismo
         * estilo de bloque que los peldaños, y asi la tarjeta se leia como si
         * el total fuera revenue menos costes menos comision MENOS NOMINA. No
         * lo es: la nomina es el sueldo de la persona, no cuelga de ningun
         * prestamo, y la comision se paga A TRAVES de ella -- restar las dos
         * contaria dos veces el mismo dinero.
         */
        <div className="border-t-2 border-slate-300 bg-slate-100 px-3 py-2">
          {p.extra}
        </div>
      )}

      {hayFuera && (
        <div className="border-t-2 border-slate-300 bg-slate-100 px-3 py-2">
          {p.elsewhere!.map((s) => s.lineas.length === 0 ? null : (
            <Fragment key={s.label}>
              {/* El subtotal de la 700, con sus bps como los demas bloques:
                  ahi siempre hay volumen, asi que no tiene el caso del cero. */}
              <div className="mt-1 flex items-baseline justify-between gap-2 text-[10px] font-semibold text-slate-600">
                <span>{s.label}</span>
                <span className="flex shrink-0 items-baseline gap-1.5 font-mono tabular-nums">
                  <span className="w-[5.5rem] text-right">
                    {usdEntero(s.lineas.reduce((a, x) => a + x.amount, 0))}
                  </span>
                  <span className="w-[4rem] text-right font-normal text-slate-400">
                    {bps(s.lineas.reduce((a, x) => a + x.amount, 0), p.amount)}
                  </span>
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

      {/*
        * ⚠ EL UNICO QUE PUEDE ESTIRARSE DE TODA LA TARJETA. El sobrante de
        * igualar el alto de la fila cae aqui, debajo de todo. Cualquier flex-1,
        * h-full o justify-between en un hijo de arriba se lo queda antes y el
        * hueco reaparece en medio -- ha pasado dos veces: primero empujando el
        * banner al fondo, luego dentro del bloque de nomina.
        */}
      <div className="flex-1 rounded-b-2xl bg-slate-100" />
    </div>
  );
}

/** Una etiqueta de la ficha. `oscuro` para cuando el fondo es el navy. */
function Etiqueta({ label, oscuro }: { label: string; oscuro?: boolean }) {
  return (
    <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
      oscuro ? "border-white/25 bg-white/10 text-white/80" : "border-slate-300 bg-white text-slate-600"
    }`}>
      {label}
    </span>
  );
}
