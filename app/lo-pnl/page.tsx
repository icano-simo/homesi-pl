"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, AlertTriangle, Info } from "lucide-react";
import { closePeriod, MONTH_NAMES_IN_ORDER } from "@/lib/close-period";
import type { LoPnlResult, OfficerBlock, LoanRow, PayrollRow } from "@/app/api/lo-pnl/route";

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

function BloquePrestamos({ loans }: { loans: LoanRow[] }) {
  if (loans.length === 0) {
    return (
      <div className="px-4 py-3 text-xs text-gray-400 italic">
        No closings in this period.
      </div>
    );
  }
  return (
    <div className="overflow-auto max-h-80">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-gray-50">
          <tr className="text-left text-gray-500 border-b border-gray-200">
            <th className="px-3 py-1.5 font-medium">Loan</th>
            <th className="px-3 py-1.5 font-medium">Period</th>
            <th className="px-3 py-1.5 font-medium text-right">Amount</th>
            <th className="px-3 py-1.5 font-medium text-right">Margin</th>
            <th className="px-3 py-1.5 font-medium text-right">Other</th>
            <th className="px-3 py-1.5 font-medium text-right">Loan net</th>
            <th className="px-3 py-1.5 font-medium text-right">LO commission</th>
          </tr>
        </thead>
        <tbody>
          {loans.map((l) => (
            <tr key={l.loan_number} className="border-b border-gray-100 hover:bg-gray-50">
              <td className="px-3 py-1 font-mono text-gray-700">{l.loan_number}</td>
              <td className="px-3 py-1 text-gray-500">{l.month} {l.year}</td>
              <td className="px-3 py-1 text-right text-gray-600">{usd(l.loan_amount)}</td>
              <td className="px-3 py-1 text-right">{usd(l.margin)}</td>
              <td className="px-3 py-1 text-right">{usd(l.other)}</td>
              <td className={`px-3 py-1 text-right font-medium ${colorNeto(l.margin + l.other)}`}>
                {usd(l.margin + l.other)}
              </td>
              <td className="px-3 py-1 text-right text-gray-500">
                {/*
                  * Null no es cero: el prestamo no cruzo con Compensafe. Un cero
                  * aqui diria "no cobro por el", que es otra cosa.
                  */}
                {l.commission == null
                  ? <span title="This loan does not cross with Compensafe. Not the same as a zero commission."
                          className="text-gray-300">—</span>
                  : usd(l.commission)}
              </td>
            </tr>
          ))}
        </tbody>
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

function Detalle({ o }: { o: OfficerBlock }) {
  return (
    <tr className="bg-gray-50/60">
      <td colSpan={7} className="px-0 py-0 border-b border-gray-200">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-0 lg:divide-x divide-gray-200">
          <div>
            <div className="px-4 pt-3 pb-1 text-[11px] font-semibold text-gray-600">
              What they produced · {o.loanCount} loan{o.loanCount !== 1 ? "s" : ""}
            </div>
            <BloquePrestamos loans={o.loans} />
          </div>
          <div>
            <div className="px-4 pt-3 pb-1 text-[11px] font-semibold text-gray-600">
              What they cost · not tied to any loan
            </div>
            <BloqueNomina rows={o.payroll} fragiles={o.payrollFragile} />
          </div>
        </div>
      </td>
    </tr>
  );
}

// ─── La pantalla ──────────────────────────────────────────────────────────────

export default function LoPnlPage() {
  const def = useMemo(() => closePeriod(), []);
  const [all, setAll] = useState(false);
  const [month, setMonth] = useState(def.month);
  const [year, setYear] = useState(String(def.year));
  const [data, setData] = useState<LoPnlResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [abierto, setAbierto] = useState<string | null>(null);
  const [notaAbierta, setNotaAbierta] = useState(false);

  const cargar = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const p = all ? "all=1" : `month=${encodeURIComponent(month)}&year=${year}`;
      const res = await fetch(`/api/lo-pnl?${p}`);
      const json = await res.json();
      if (!res.ok) { setError(json.error ?? "Failed to load"); return; }
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [all, month, year]);

  useEffect(() => { cargar(); }, [cargar]);

  const officers = data?.officers ?? [];
  const totales = useMemo(() => ({
    prestamos: officers.reduce((s, o) => s + o.loanCount, 0),
    volumen: officers.reduce((s, o) => s + o.volume, 0),
    produccion: officers.reduce((s, o) => s + o.block1Net, 0),
    coste: officers.reduce((s, o) => s + o.block2Total, 0),
    neto: officers.reduce((s, o) => s + o.total, 0),
  }), [officers]);

  const sinNomina = officers.filter((o) => o.payrollStatus === "not_located" && o.loanCount > 0);
  const fueraDeNomina = officers.filter((o) => o.commissionOutsidePayroll);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-bold text-[#001A40]">P&amp;L by Loan Officer</h1>
          <p className="mt-0.5 text-xs text-slate-500">
            What each person produced, what they were paid for it, and what they cost.
          </p>
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
          <div className="rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-gray-50">
                <tr className="text-left text-gray-500 border-b border-gray-200">
                  <th className="px-3 py-2 font-medium">Loan Officer</th>
                  <th className="px-3 py-2 font-medium text-right">Loans</th>
                  <th className="px-3 py-2 font-medium text-right">Volume</th>
                  <th className="px-3 py-2 font-medium text-right" title="Margin plus other loan income and costs, for the loans they closed.">
                    Produced
                  </th>
                  <th className="px-3 py-2 font-medium text-right" title="Paid to this person per loan, from Compensafe. Shown for reference: it is NOT subtracted here, because the same money is already inside payroll.">
                    Paid on loans
                  </th>
                  <th className="px-3 py-2 font-medium text-right" title="Everything paid to this person that does not hang off a loan: salary, bonus, taxes, insurance, equipment.">
                    Cost
                  </th>
                  <th className="px-3 py-2 font-medium text-right">Net</th>
                </tr>
              </thead>
              <tbody>
                {officers.map((o) => {
                  const id = o.personCode ?? o.name;
                  const abre = abierto === id;
                  return (
                    // La key va en el Fragment, no en el <tr>: una fila y su
                    // detalle son DOS hermanos de la misma lista, y React pide
                    // la key en el elemento raiz de cada iteracion.
                    <Fragment key={id}>
                      <tr
                        onClick={() => setAbierto(abre ? null : id)}
                        className="border-b border-gray-100 hover:bg-blue-50/40 cursor-pointer">
                        <td className="px-3 py-1.5">
                          <span className="inline-flex items-center">
                            {abre ? <ChevronDown size={12} className="mr-1 text-gray-400" />
                                  : <ChevronRight size={12} className="mr-1 text-gray-400" />}
                            <span className="font-medium text-gray-800">{o.name}</span>
                          </span>

                          {/* Las salvedades, SOLO en la fila que afectan. */}
                          {o.loanCount > 0 && o.payrollStatus === "not_located" && (
                            <Marca tono="ambar"
                              title="No payroll row anywhere in the P&L carries this name. This is not a zero: it is an absence, and it is the finding this module exists to surface.">
                              no payroll
                            </Marca>
                          )}
                          {o.commissionOutsidePayroll && (
                            <Marca tono="ambar"
                              title="Has commission in Compensafe but no row in any compensation account. Their cost is understated here.">
                              comp not in payroll
                            </Marca>
                          )}
                          {o.payrollStatus === "fragile_only" && (
                            <Marca title="Only found through less reliable description shapes. Shown in the detail, outside the total.">
                              weak match
                            </Marca>
                          )}
                          {o.loanCount === 0 && (
                            <Marca title="Payroll but no closings in this period.">no closings</Marca>
                          )}
                          {o.truncatedRows > 0 && (
                            <Marca title={`${o.truncatedRows} row(s) arrived at the 35-character limit, so the name may be cut.`}>
                              {o.truncatedRows} truncated
                            </Marca>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-right text-gray-600">{o.loanCount || "—"}</td>
                        <td className="px-3 py-1.5 text-right text-gray-600">{o.volume ? usd(o.volume) : "—"}</td>
                        <td className="px-3 py-1.5 text-right">{o.loanCount ? usd(o.block1Net) : "—"}</td>
                        <td className="px-3 py-1.5 text-right text-gray-500">
                          {o.block1Commission ? usd(o.block1Commission) : "—"}
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          {o.payrollStatus === "not_located"
                            ? <span className="text-amber-600" title="Not located — not the same as zero.">—</span>
                            : usd(o.block2Total)}
                        </td>
                        <td className={`px-3 py-1.5 text-right font-semibold ${colorNeto(o.total)}`}>
                          {usd(o.total)}
                        </td>
                      </tr>
                      {abre && <Detalle o={o} />}
                    </Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="bg-gray-50 border-t-2 border-gray-300 font-semibold text-gray-700">
                  <td className="px-3 py-2">{officers.length} people</td>
                  <td className="px-3 py-2 text-right">{totales.prestamos}</td>
                  <td className="px-3 py-2 text-right">{usd(totales.volumen)}</td>
                  <td className="px-3 py-2 text-right">{usd(totales.produccion)}</td>
                  <td className="px-3 py-2 text-right text-gray-500">—</td>
                  <td className="px-3 py-2 text-right">{usd(totales.coste)}</td>
                  <td className={`px-3 py-2 text-right ${colorNeto(totales.neto)}`}>{usd(totales.neto)}</td>
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
                    <span className="font-semibold text-gray-700">Commission outside payroll.</span>{" "}
                    {fueraDeNomina.map((o) => o.name).join(", ")} earned commission but has no row in any
                    compensation account, so their cost here is understated by{" "}
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
    </div>
  );
}
