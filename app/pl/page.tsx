"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, ChevronDown, ChevronRight, MessageSquare } from "lucide-react";
import { PivotTableDynamic } from "@/components/pivot-table-dynamic";
import { ReportFilter } from "@/components/report-filter";
import { LoanMetricsByMonthBar } from "@/components/loan-metrics-by-month";
import { useLoanMetrics } from "@/lib/use-loan-metrics";
import { LoanDetailDrawer } from "@/components/loan-detail-drawer";
import { CellDetailModal } from "@/components/cell-detail-modal";
import { NoteWindow } from "@/components/note-window";
import { HiddenNotesBadge, HiddenNotesModal, type HiddenNote } from "@/components/hidden-notes";
import { NotesLog } from "@/components/notes-log";
import { buildSplitsMap } from "@/lib/apply-splits";
import { downloadCSV } from "@/lib/csv";
import { hierarchyLabel, hierarchyLevels, SHAPE_LABELS, type HierarchyShape } from "@/lib/pl-hierarchies";
import { useActiveBranches, mergeWithGlobal } from "@/components/branch-filter-provider";
import { AFFINITY_HOST_BRANCH, type AffinityLens } from "@/lib/loan-branch";
import type { SplitEntry } from "@/lib/apply-splits";
import { OrphanedNotesPanel } from "@/components/orphaned-notes-panel";
import { defaultScopeLabel, isPivotScope, reportBaseScope, scopeContains } from "@/lib/note-scope";
import { closePeriod } from "@/lib/close-period";
import type { CellRef } from "@/lib/cell-ref";
import type { PLNote, ScopeKey } from "@/lib/note-scope";
import type { PivotField } from "@/lib/pivot-engine";
import type { CostCenter, PLReportTx, FilterOptionsResponse } from "@/types";

const MONTH_ORDER = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

/** Every dimension a note can be anchored by here, for orphan breadcrumbs. */
const SCOPE_ORDER: ScopeKey[] = [
  "branch", "cost_center", "op_nonop", "category_6", "category_7", "gl", "month", "year",
];

const CSV_COLUMNS = [
  { key: "month",            label: "Month" },
  { key: "branch",           label: "Branch" },
  { key: "gl_code",          label: "GL Code" },
  { key: "gl_name",          label: "GL Name" },
  { key: "category_2",       label: "Category 2" },
  { key: "category_6",       label: "Category 6" },
  { key: "category_7",       label: "Category 7" },
  { key: "check_description",label: "Description" },
  { key: "vendor",           label: "Vendor" },
  { key: "ref_numb",         label: "Ref #" },
  { key: "debit",            label: "Debit" },
  { key: "credit",           label: "Credit" },
  { key: "movement",         label: "Movement" },
];

const SOURCE_LABELS: Record<string, string> = {
  original:             "Original",
  addback:              "Addback",
  offshore_allocations: "OA",
  manual_entry:         "Manual Entry",
};
function srcLabel(s: string) { return SOURCE_LABELS[s] ?? s; }

/**
 * The one thing on screen besides the report.
 *
 * A single value rather than one flag per window, and that is the whole point:
 * with three booleans, "only one open at a time" is a rule that every new
 * caller has to remember. With one value it is a property of the state — two
 * cannot be open because there is nowhere to put the second.
 */
type Panel =
  | { kind: "loans"; month: string }
  | { kind: "cell";  ref: CellRef }
  | { kind: "notes"; ref: CellRef }
  | { kind: "hidden" }
  | null;

function FilterChip({ label, value }: { label: string; value: string }) {
  // Branch gets more weight than the rest. It is the context that slips out of
  // mind first when reading a grid of figures, and reading the right numbers
  // under the wrong branch is the expensive mistake.
  const isBranch = label === "Branch";
  return (
    <span
      className={
        isBranch
          ? "inline-flex items-center gap-1.5 rounded-full border border-sky-300 bg-sky-100 px-3.5 py-1.5 text-sm font-bold text-sky-900"
          : "inline-flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-medium text-sky-900"
      }
    >
      <span className={isBranch ? "text-xs font-semibold uppercase tracking-wide text-sky-600" : "font-normal text-sky-500"}>
        {label}:
      </span>
      {value}
    </span>
  );
}

export default function PLPage() {
  const { activeBranches, isLoaded: branchFilterLoaded } = useActiveBranches();
  const [opts, setOpts] = useState<FilterOptionsResponse | null>(null);

  const [years,    setYears]    = useState<string[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [sources,  setSources]  = useState<string[]>([]);
  const [months,   setMonths]   = useState<string[]>([]);

  const [rawTxs,    setRawTxs]    = useState<PLReportTx[]>([]);
  const [allSplits, setAllSplits] = useState<SplitEntry[]>([]);
  const [notes,     setNotes]     = useState<PLNote[]>([]);
  const [orphans,   setOrphans]   = useState<PLNote[]>([]);
  /** The same set the table drew its indicators from — see onResolvedNotes. */
  const [placedNotes, setPlacedNotes] = useState<PLNote[]>([]);

  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");
  const [loaded,  setLoaded]  = useState(false);
  const autoLoaded = useRef(false);

  // The four named views. No reordering, so nothing to persist and nothing
  // that can differ between two people looking at the same report.
  const [shape,   setShape]   = useState<HierarchyShape>("regular");
  const [opNonOp, setOpNonOp] = useState(false);

  const [costCenterNames, setCostCenterNames] = useState<string[]>([]);
  const [costCenters,     setCostCenters]     = useState<CostCenter[]>([]);
  const [glCodes, setGlCodes] = useState<string[]>([]);
  const [logOpen, setLogOpen] = useState(true);

  const [loadedYears,    setLoadedYears]    = useState<string[]>([]);

  const [loadedBranches, setLoadedBranches] = useState<string[]>([]);
  const [loadedSources,  setLoadedSources]  = useState<string[]>([]);

  /*
   * ─────────────────────────────────────────────────────────────────────────
   * LA LENTE DE AFFINITY: SE ELIGE UNA VEZ Y VALE PARA TODA LA PANTALLA
   * ─────────────────────────────────────────────────────────────────────────
   *
   * ⚠ VIVE AQUI Y NO DENTRO DE CADA MODULO, y ese es todo el diseño. Un primer
   * intento la puso dentro del P&L por Loan Officer, y entonces la rejilla, el
   * loan count y las tarjetas seguian enseñando la 716 entera mientras el
   * modulo enseñaba una mitad: dos respuestas distintas en la misma pantalla,
   * sin nada que dijera cual era cual.
   *
   * ⚠ Y SU ESTADO TIENE QUE ENTRAR EN LAS CUATRO PETICIONES:
   *
   *     /api/pl-all        `lens` en la URL, y `lente` en el efecto de recarga
   *     /api/loan-metrics  `lens` en la URL, y `lente` en la CLAVE del hook
   *     /api/loan-detail   `lens` en la URL, y `lente` en la clave del drawer
   *     /api/lo-pnl        `lens` en la URL, y `lente` en el useCallback
   *
   * Por que eso es una trampa y no una lista --el mismo olvido con cuatro
   * formas distintas, y el sintoma de que la interfaz responde y los datos
   * no-- esta junto al tipo `AffinityLens`, en lib/loan-branch.ts, que es lo
   * que va a leer quien añada el quinto consumidor.
   *
   * ⚠ SOLO SE OFRECE CON LA 716 SOLA. Con varias sucursales, dos de las tres
   * lentes darian lo mismo que la tercera en todo menos en una, y un control
   * que casi nunca cambia nada invita a pulsarlo y a desconfiar de el.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * ⚠ SON TRES VISTAS, NO TRES TROZOS DE UNA TARTA. NO SE SUMAN.
   * ═══════════════════════════════════════════════════════════════════════
   *
   *     Affinity            97.015,49
   *     716 puro          -147.813,11
   *     suma               -50.797,62
   *     ambas              -50.297,62      <- el libro entero de la 716
   *     diferencia            -500,00      <- Gian Laino, sucursal 747
   *
   * EL PORQUE, EN UNA LINEA: lo que queda son los 500 de Gian Laino, que
   * Affinity cuenta como coste de sus prestamos y la 716 nunca tuvo -- su
   * comision esta en el 60105 de la SUCURSAL 747, porque el libro contabiliza
   * donde esta la persona.
   *
   * La nota va AQUI, donde se elige la lente, y no solo junto a las filas que
   * lo provocan: quien cambia entre ellas es justo quien va a intentar
   * sumarlas.
   *
   * ⚠ Y "ambas" DA EL LIBRO ENTERO DE LA 716, -50.297,62, que es lo correcto:
   * esa lente no añade ni quita nada, porque la cuenta 60105 ya lo lleva todo
   * dentro.
   *
   * ⚠ ESTA PROPIEDAD HA CAMBIADO DOS VECES, y por eso se escribe con su
   * historia en vez de como un hecho:
   *
   *   1. Al principio las tres SUMABAN al centimo --1.828 + 379 = 2.207 filas.
   *   2. Al añadir la fila de comision en Affinity dejaron de sumar, por
   *      20.863,79.
   *   3. Al poder sacar de la 716 la comision de Affinity que su cuenta lleva
   *      dentro --20.363,79, via comp.payroll_transaction-- el hueco bajo a
   *      500,00.
   *
   * Los 500 que quedan no son un defecto ni se pueden cerrar desde aqui: son
   * dinero contabilizado en una TERCERA sucursal. Cerrarlos exigiria que la
   * lente de Affinity dejara fuera la comision de gente de otras sucursales, y
   * eso cambiaria lo que la lente significa.
   *
   * Una propiedad verificada que nadie revisa cuando cambia el codigo se
   * convierte en una nota falsa, que es peor que no haberla escrito.
   */
  const [lente, setLente] = useState<AffinityLens>("ambas");

  // Same panel as P&L All, same hook, same filters the table is showing.
  const loanMetrics = useLoanMetrics(loadedYears, loadedBranches, loadedSources, undefined, lente);

  const [panel, setPanel] = useState<Panel>(null);

  /** Notes come from their own endpoint, so posting one refreshes just them
   *  rather than re-downloading every transaction behind the report. */
  async function refreshNotes(yrs: string[]) {
    try {
      const p = new URLSearchParams();
      yrs.forEach((y) => p.append("year", y));
      const res = await fetch(`/api/pl-notes?${p}`);
      if (res.ok) setNotes(await res.json());
    } catch (e) {
      console.error(e);
    }
  }

  async function fetchData(yrs: string[], brs: string[], srcs: string[]) {
    setLoading(true); setError("");
    try {
      const effectiveBranches = mergeWithGlobal(activeBranches, brs);
      const p = new URLSearchParams();
      yrs.forEach(y => p.append("year", y));
      effectiveBranches.forEach(b => p.append("branch", b));
      srcs.forEach(s => p.append("source", s));
      if (lente !== "ambas") p.append("lens", lente);
      const res = await fetch(`/api/pl-all?${p}`);
      if (!res.ok) { const j = await res.json(); setError(j.error ?? "Error"); return; }
      setRawTxs(await res.json());
      void refreshNotes(yrs);
      setLoaded(true);
      setMonths([]);
      setLoadedYears(yrs);
      setLoadedBranches(effectiveBranches);
      setLoadedSources(srcs);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!branchFilterLoaded) return;
    Promise.all([
      fetch("/api/transactions/filter-options").then(r => r.json()),
      fetch("/api/cc-allocation-splits").then(r => r.json()),
      fetch("/api/cost-centers").then(r => r.json()),
    ]).then(([filterOpts, splits, ccs]: [FilterOptionsResponse, SplitEntry[], CostCenter[]]) => {
      setOpts(filterOpts);
      setAllSplits(splits);
      setCostCenters(ccs);
      /**
       * The year of the month just closed — the same rule as /start, from the
       * one function that owns it.
       *
       * It used to be "the last year in the options", which is the same answer
       * most of the time and the wrong one every January: on the 2nd of January
       * the close is December, and the newest year loaded is already the new one.
       *
       * The MONTH is deliberately left unselected. This report is read across
       * months — a column per month is its whole shape — so preselecting one
       * would collapse the grid to a single column. /start is where a single
       * period is the subject; here the period is the axis.
       */
      const defaultYear = [String(closePeriod().year)];
      setYears(defaultYear);
      if (!autoLoaded.current && defaultYear.length > 0) {
        autoLoaded.current = true;
        fetchData(defaultYear, [], []);
      }
    }).catch(console.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchFilterLoaded]);

  const monthOptions = useMemo(
    () => MONTH_ORDER.filter(m => rawTxs.some(t => t.month === m)),
    [rawTxs]
  );

  const glCodeOptions = useMemo(
    () => [...new Set(rawTxs.map(t => t.gl_code).filter(Boolean) as string[])].sort(),
    [rawTxs]
  );

  const txs = useMemo(() => {
    let out = rawTxs;
    if (months.length  > 0) out = out.filter(t => t.month   && months.includes(t.month));
    if (glCodes.length > 0) out = out.filter(t => t.gl_code && glCodes.includes(t.gl_code));

    /*
     * ═════════════════════════════════════════════════════════════════════
     * LA COMISION DEL LO, COMO UNA FILA MAS DE LA TABLA
     * ═════════════════════════════════════════════════════════════════════
     *
     * Estuvo en un cuadro aparte bajo la rejilla y estaba mal: dejaba DOS
     * totales en la misma pantalla --el del libro y el de la linea de
     * negocio-- y quien mirara el de arriba leia una cifra a la que le
     * faltaba el coste del loan officer. Ahora entra en la tabla, suma en el
     * total como las demas, y hay un solo total.
     *
     * ⚠ SOLO EN LA LENTE DE AFFINITY, Y NO ES UNA PREFERENCIA: EN LAS OTRAS
     * DOS CONTARIA EL MISMO DINERO DOS VECES. Medido ejecutando las rutas:
     *
     *     lente       60105 en la rejilla   de eso, comision   ¿duplica?
     *     Affinity          0 filas                 --          NO
     *     716 puro       -291.803,96         -269.790,66        SI
     *     ambas          -291.803,96         -269.790,66        SI
     *
     * La nomina del loan officer ES la cuenta 60105, y en "716 puro" y en
     * "ambas" ya esta en la tabla con su comision dentro. Solo la lente de
     * Affinity se queda sin ella --sus filas de nomina no existen, porque la
     * nomina se queda entera en la 716-- y ahi la comision es la UNICA forma
     * de ver lo que costo el loan officer de esos prestamos.
     *
     * ⚠ Y NO SE PUEDE RESTAR DE LA 716 PARA COMPENSAR. Restarla exigiria
     * partir las 130 filas de 60105 por prestamo, y NINGUNA tiene
     * loan_number: la misma limitacion del dato que documenta
     * lib/payroll-breakdown.ts.
     *
     * ⚠ ESTO CAMBIA EL TOTAL DE LA PANTALLA con esa lente, a proposito: de
     * 117.879,28 a 97.015,49. El total pasa a incluir una cifra que NO esta
     * en la contabilidad, y por eso la fila lleva su origen en la
     * descripcion: quien intente cuadrar la pantalla contra el libro tiene
     * que poder ver cual es.
     *
     * ═════════════════════════════════════════════════════════════════════
     * ⚠ Y LAS DOS LENTES YA NO SUMAN A "AMBAS". ES CORRECTO Y HAY QUE SABERLO
     * ═════════════════════════════════════════════════════════════════════
     *
     *     Affinity            97.015,49
     *     716 puro          -168.176,90
     *     suma               -71.161,41
     *     ambas              -50.297,62
     *     diferencia         -20.863,79   <- la comision de Affinity
     *
     * Antes de esta fila las tres cuadraban al centimo --1.828 + 379 = 2.207
     * filas, e importes que sumaban-- y esa propiedad se verifico y se
     * anuncio. Ya no se cumple, y la diferencia es EXACTAMENTE la comision.
     *
     * LA RAZON, y es la que lo hace correcto: los 20.863,79 YA ESTAN en el
     * libro, dentro de los 269.790,66 de comision que lleva la cuenta 60105
     * --pero contabilizados en la 716, porque la nomina del loan officer se
     * queda alli entera--. La lente de Affinity los enseña como fila propia
     * porque en su vista no hay 60105; la de 716 los lleva dentro de esa
     * cuenta sin poder separarlos. O sea que el mismo dinero se ve en las dos
     * lentes, en sitios distintos, y por eso sumarlas lo cuenta dos veces.
     *
     * NO SE ARREGLA restandolo de la 716: exigiria partir las 130 filas de
     * 60105 por prestamo y ninguna tiene loan_number.
     *
     * ⚠ LO QUE ESTO SIGNIFICA PARA QUIEN LEA LA PANTALLA: las tres lentes son
     * TRES VISTAS, no tres trozos de una tarta. Cada una contesta bien su
     * pregunta y no estan hechas para sumarse.
     */
    const c = loanMetrics.data?.commission;
    if (lente === "affinity" && c && c.total !== 0) {
      const base = rawTxs[0];
      const sintetica = Object.entries(c.by_month ?? {})
        .filter(([, v]) => v !== 0)
        .map(([mes, v], i) => ({
          ...base,
          id: `compensafe-commission-${mes}-${i}`,
          month: mes,
          branch: AFFINITY_HOST_BRANCH,
          // Sin gl_code: no es una cuenta del libro, y el hueco es la señal.
          gl_code: null,
          /* ⚠ "by closing month" EN EL ROTULO, no en un tooltip. La tarjeta del
             prestamo y esta fila dan cifras distintas para el mismo mes --500
             contra 1.000 en julio-- porque cada una ordena por una fecha, y sin
             decirlo parece que falta dinero. Son cuatro prestamos de 500: dos
             cerraron en junio y se pagaron el 15 de julio, uno cerro y se pago
             en julio, y otro cerro en julio y se pago el 14 de agosto. */
          gl_name: "LO commission · Compensafe · by closing month",
          // En el grupo de 60105, que es donde alguien la busca.
          category_2: "Operating Income (Loss) Before BM Payroll",
          category_6: "Production Compensation",
          category_7: "Loan Officer Payroll",
          check_description:
            "Loan officer commission on Affinity loans — from Compensafe, not from the general ledger",
          vendor: null,
          ref_numb: null,
          loan_number: null,
          debit: 0,
          credit: 0,
          movement: -v,
          cost_center_id: null,
          cost_center_status: null,
        })) as unknown as PLReportTx[];
      if (base) out = [...out, ...sintetica];
    }

    /*
     * ═════════════════════════════════════════════════════════════════════
     * Y EN "716 PURO", LA COMISION DE AFFINITY SALE DE LA CUENTA
     * ═════════════════════════════════════════════════════════════════════
     *
     * Esto se dijo imposible y no lo era. Las 130 filas de 60105 del P&L no
     * tienen `loan_number` --cierto, verificado-- asi que DESDE EL LIBRO no hay
     * forma de saber cuales son de Affinity. Pero `comp.payroll_transaction` SI
     * lo trae en sus lineas de comision, y esa es la tabla de la que ya sale el
     * desglose de la cuenta: el reparto no se inventa, se lee de la fuente que
     * la explica.
     *
     * ⚠ VA COMO FILA APARTE Y NO CAMBIANDO EL IMPORTE DE 60105. La cuenta sigue
     * enseñando lo que dice el libro --291.803,96-- y el ajuste se ve como lo
     * que es. Cambiar la cifra de la cuenta habria dejado la rejilla diciendo
     * de 60105 algo que contabilidad no dice, que es lo que llevamos toda la
     * pantalla evitando. El total del grupo sale igual: -271.440,17.
     *
     * ⚠ SON 20.363,79, NO 20.863,79, y la diferencia son 500 de Gian Laino:
     * sucursal 747, un prestamo de Affinity, comision contabilizada en el 60105
     * de la 747 y no en el de la 716. Se resta lo que la cuenta LLEVA DENTRO,
     * no lo que la linea de negocio costo.
     */
    /*
     * ⚠ UNA FILA POR MES, Y ESO FUE UN BUG. La primera version ponia
     * `month: rawTxs[0]?.month` -- el ajuste ENTERO en el mes de la primera
     * transaccion del payload, uno cualquiera. En julio salia 0,00 y en el mes
     * que tocara salian los 20.363,79 de golpe. El total anual cuadraba, que es
     * justo lo que hizo que pasara desapercibido.
     *
     * ⚠ Y POR MES DE PAGO, no de cierre, al reves que la fila de Affinity. No
     * es una incoherencia: esta saca de la cuenta 60105 lo que la cuenta lleva
     * dentro, y el libro la contabiliza por fecha de PAGO. Verificado sobre
     * julio de 2026: la cuenta trae 28.896,38 y la comision de Affinity pagada
     * en julio son 1.000,00 -- neto 27.896,38. Por mes de cierre habrian sido
     * 500,00, que es otra cosa. El porque completo, en la ruta.
     */
    const enCuenta = loanMetrics.data?.affinity_in_account;
    if (lente === "716" && enCuenta && enCuenta.total !== 0) {
      const base = rawTxs[0];
      const porMes = Object.entries(enCuenta.by_month ?? {}).filter(([, v]) => v !== 0);
      if (base) {
        out = [...out, ...porMes.map(([mes, v], i) => ({
          ...base,
          id: `compensafe-affinity-out-of-60105-${mes}-${i}`,
          month: mes,
          branch: AFFINITY_HOST_BRANCH,
          gl_code: null,
          /* Esta va por fecha de PAGO, porque saca de una cuenta que el libro
             contabiliza asi. Ver la nota de la ruta. */
          gl_name: "less: commission on Affinity loans · Compensafe · by pay date",
          category_2: "Operating Income (Loss) Before BM Payroll",
          category_6: "Production Compensation",
          category_7: "Loan Officer Payroll",
          check_description:
            `Commission on Affinity loans that account 60105 carries, by payment month — ${enCuenta.lines} lines in total. Taken out here so this lens shows 716 without Affinity. Identified through comp.payroll_transaction, which carries the loan number that the ledger rows do not.`,
          vendor: null,
          ref_numb: null,
          loan_number: null,
          debit: 0,
          credit: 0,
          movement: v,
          cost_center_id: null,
          cost_center_status: null,
        })) as unknown as PLReportTx[]];
      }
    }

    return out;
  }, [rawTxs, months, glCodes, lente, loanMetrics.data]);

  const splitsMap = useMemo(() => buildSplitsMap(allSplits), [allSplits]);

  const levels = useMemo(() => hierarchyLevels({ shape, opNonOp }), [shape, opNonOp]);

  const ccOptions = useMemo(
    () => [...costCenters.map(c => c.name).sort(), "Unassigned", "Conflict"],
    [costCenters]
  );

  /**
   * The filter as stable scope values, which is what the table compares
   * against. Resolved here and memoised so the table’s own memo is not
   * invalidated on every render.
   */
  const costCenterFilter = useMemo<string[] | null>(() => {
    if (costCenterNames.length === 0) return null;
    return costCenterNames.map((name) => {
      if (name === "Unassigned") return "__unassigned__";
      if (name === "Conflict")   return "__conflict__";
      return costCenters.find(c => c.name === name)?.id ?? "__none__";
    });
  }, [costCenterNames, costCenters]);

  /** A log belongs to one entity; with several picked there is no single
   *  history to show. */
  const logCostCenter = useMemo(() => {
    if (costCenterNames.length !== 1) return null;
    const name = costCenterNames[0];
    if (name === "Unassigned") return { id: "__unassigned__", name };
    if (name === "Conflict")   return { id: "__conflict__",   name };
    const cc = costCenters.find(c => c.name === name);
    return cc ? { id: cc.id, name: cc.name } : null;
  }, [costCenterNames, costCenters]);

  function handleExport() {
    const suffix = loadedYears.length === 1 ? `_${loadedYears[0]}` : "";
    downloadCSV(`pl${suffix}.csv`, txs as unknown as Record<string, unknown>[], CSV_COLUMNS);
  }

  /** Anchor notes to a year only when the report covers exactly one. With
   *  several loaded a month column merges them, so the cell spans periods and
   *  has none to point at. */
  /**
   * The one branch the report is scoped to, or null.
   *
   * Notes are anchored to it, so it has to be a single value: with several
   * branches loaded there is no one branch the reader was looking at, and the
   * composer says so rather than picking one.
   */
  const scopeBranch = useMemo(
    () => (loadedBranches.length === 1 ? loadedBranches[0] : null),
    [loadedBranches],
  );

  /** La lente solo significa algo en la sucursal que se parte en dos. */
  const hayLente = scopeBranch === AFFINITY_HOST_BRANCH;

  /*
   * ⚠ AL SALIR DE LA 716 SE VUELVE A "ambas". Quedarse en la lente de Affinity
   * al cargar otra sucursal enseñaria sus cifras enteras bajo un rotulo que ya
   * no sale en pantalla, porque el selector desaparece con ella.
   */
  useEffect(() => {
    if (!hayLente && lente !== "ambas") setLente("ambas");
  }, [hayLente, lente]);

  /*
   * La rejilla se recarga al cambiar de lente. `fetchData` ya lleva `lens` en
   * la URL; esto es lo que hace que se vuelva a llamar -- sin ello el selector
   * cambiaria el loan count y las tarjetas, y dejaria la rejilla como estaba.
   */
  const lenteCargada = useRef<AffinityLens>("ambas");
  useEffect(() => {
    if (!loaded) { lenteCargada.current = lente; return; }
    if (lenteCargada.current === lente) return;
    lenteCargada.current = lente;
    void fetchData(loadedYears, loadedBranches, loadedSources);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lente, loaded]);

  /**
   * The one cost centre the report is scoped to, or null.
   *
   * Same rule as the branch: a single value or nothing. The filter holds display
   * names, so it is resolved back to the stable value the pivot groups by —
   * a cost_center_id, or the "__unassigned__" / "__conflict__" sentinels.
   */
  const scopeCostCenter = useMemo(
    () => (costCenterFilter && costCenterFilter.length === 1 ? costCenterFilter[0] : null),
    [costCenterFilter],
  );

  const scopeYear = useMemo(() => {
    const ys = new Set(rawTxs.map(t => t.year).filter((y): y is number => y != null));
    return ys.size === 1 ? [...ys][0] : undefined;
  }, [rawTxs]);

  /**
   * Stable ids in a note's scope are not display text.
   *
   * Built here rather than inside the notes window because the raw transactions
   * are the only place the names live: a scope stores 41309 and a cost centre
   * UUID, and a window that printed those verbatim would be telling the reader
   * what the note is anchored to in a language only the database speaks.
   */
  const labelFor = useMemo(() => {
    const glNames = new Map<string, string>();
    const ccNames = new Map<string, string>();
    for (const tx of rawTxs) {
      if (tx.gl_code) glNames.set(tx.gl_code, tx.gl_name ? `${tx.gl_code} — ${tx.gl_name}` : tx.gl_code);
      if (tx.cost_center_id && tx.cost_centers?.name) ccNames.set(tx.cost_center_id, tx.cost_centers.name);
    }
    return (key: ScopeKey, value: string): string => {
      if (key === "gl")             return glNames.get(value) ?? value;
      if (key === "cost_center")    return ccNames.get(value) ?? defaultScopeLabel(key, value);
      // A raw UUID adds nothing to a trail; scopeBreadcrumb drops empty crumbs.
      if (key === "transaction_id") return "";
      return defaultScopeLabel(key, value);
    };
  }, [rawTxs]);

  /**
   * Notes a branch filter is hiding right now.
   *
   * A note with no branch in its scope only shows where no branch is
   * constrained — that is the rule and it is the one we wanted. But a note that
   * vanishes without a word reads as a note that was lost: someone went looking
   * for the two June notes and thought they had been deleted. So when a branch
   * filter is on and there are branchless notes it is hiding, the page says how
   * many.
   *
   * Counted from the notes for this year that belong to the report at all —
   * NotesLog entries anchored to a cost centre or an employee are not part of
   * the pivot and were never going to show here.
   */
  /**
   * The notes the active filters are hiding, and why — one list, not one per
   * dimension.
   *
   * Tested with the same scopeContains the report uses against the same
   * reportBaseScope the pivot seeds its tree with, so this cannot disagree with
   * what is actually on screen. A note is hidden when it does not carry every
   * constraint the cells now carry: no branch while a branch is filtered, no
   * cost centre — or a different one — while a cost centre is.
   *
   * One message covering both. Two banners in the same bar is noise, and the
   * reader does not care which dimension did it until they open it.
   */
  const hidden = useMemo(() => {
    const base = reportBaseScope({ year: scopeYear, branch: scopeBranch, costCenter: scopeCostCenter });
    if (!scopeBranch && !scopeCostCenter) return [];
    const ccName = (v: unknown) =>
      costCenters.find((c) => c.id === String(v))?.name ?? String(v);
    return notes
      .filter((n) => isPivotScope(n.scope) && !scopeContains(n.scope, base))
      .map<HiddenNote>((n) => {
        // Which dimension actually puts it out of scope. Both are shown either
        // way; this is what the modal paints amber.
        const reasons: string[] = [];
        if (scopeCostCenter && String(n.scope.cost_center ?? "") !== scopeCostCenter) reasons.push("cost_center");
        if (scopeBranch && String(n.scope.branch ?? "") !== scopeBranch) reasons.push("branch");
        /*
         * ⚠ EL AÑO TAMBIEN ES UN MOTIVO, y faltaba. Una nota de la MISMA
         * sucursal queda fuera si no lleva año propio --el caso de las dos
         * escritas con dos años cargados-- y sin esto aparecia en la lista con
         * las dos etiquetas en gris, sin nada que dijera por que estaba ahi.
         */
        if (scopeYear != null && String(n.scope.year ?? "") !== String(scopeYear)) reasons.push("year");
        return {
          note: n,
          costCenter: n.scope.cost_center != null ? ccName(n.scope.cost_center) : null,
          branch: n.scope.branch != null ? String(n.scope.branch) : null,
          reasons,
        };
      });
  }, [notes, scopeYear, scopeBranch, scopeCostCenter, costCenters]);

  const loadedChips: { label: string; value: string }[] = [];
  if (loadedYears.length > 0)
    loadedChips.push({ label: "Year", value: loadedYears.length === 1 ? loadedYears[0] : `${loadedYears.length} years` });
  if (loadedBranches.length > 0)
    loadedChips.push({ label: "Branch", value: loadedBranches.length === 1 ? loadedBranches[0] : `${loadedBranches.length} branches` });
  if (loadedSources.length > 0)
    loadedChips.push({ label: "Source", value: loadedSources.map(srcLabel).join(", ") });
  if (months.length > 0)
    loadedChips.push({ label: "Month", value: months.length === 1 ? months[0] : `${months.length} months` });
  if (costCenterNames.length > 0)
    loadedChips.push({ label: "Cost Center", value: costCenterNames.length === 1 ? costCenterNames[0] : `${costCenterNames.length} centers` });
  if (glCodes.length > 0)
    loadedChips.push({ label: "GL Code", value: glCodes.length === 1 ? glCodes[0] : `${glCodes.length} codes` });

  return (
    // Canvas colour is scoped here rather than applied to <body> so the rest of
    // the portal keeps its current background until its own redesign pass.
    // -m-6 cancels the layout's padding so the tint reaches the edges.
    <div className="-m-6 min-h-screen bg-[#FCFCFA]">
    <div className="mx-auto flex max-w-[1440px] flex-col gap-4 px-6 py-4">
      {/* Filter bar */}
      <div className="sticky top-0 z-30 rounded-2xl border border-slate-200 bg-slate-50 p-3 shadow-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-xs font-bold uppercase tracking-wider text-[#001A40]">
            Filters:
          </span>

          <ReportFilter label="Year"   options={(opts?.year ?? []).map(String)} selected={years}    onChange={setYears} />
          <ReportFilter label="Branch" options={opts?.branch ?? []}             selected={branches} onChange={setBranches} />
          <ReportFilter label="Source" options={opts?.source ?? []}             selected={sources}  onChange={setSources} />

          <button
            onClick={() => fetchData(years, branches, sources)}
            disabled={loading}
            className="rounded-full bg-[#FF4040] px-5 py-2 text-xs font-bold text-white shadow-xs hover:bg-[#e03535] disabled:opacity-40"
          >
            {loading ? "Loading…" : "Run Report"}
          </button>

          {loaded && (
            <>
              <span className="text-slate-300">|</span>
              <ReportFilter label="Month"       options={monthOptions}  selected={months}          onChange={setMonths} />
              <ReportFilter label="Cost Center" options={ccOptions}     selected={costCenterNames} onChange={setCostCenterNames} />
              <ReportFilter label="GL Code"     options={glCodeOptions} selected={glCodes}         onChange={setGlCodes} />
              <button
                onClick={handleExport}
                className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 hover:border-slate-300"
              >
                <Download size={12} /> CSV
              </button>
            </>
          )}
        </div>

        {loaded && loadedChips.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {loadedChips.map((chip) => (
              <FilterChip key={chip.label} label={chip.label} value={chip.value} />
            ))}

            {/*
              * ⚠ EL SELECTOR VA JUNTO A LOS CHIPS DEL FILTRO, no junto a la
              * rejilla: acota TODA la pantalla igual que ellos, y ponerlo sobre
              * una de las cuatro cosas que cambia haria pensar que solo cambia
              * esa.
              */}
            {hayLente && (
              <span
                className="ml-2 inline-flex overflow-hidden rounded-full border border-[#A6DEFF] text-xs"
                title="Three views, not three slices of a pie — they do not quite add up. The 500 gap is Gian Laino: his commission on an Affinity loan sits in branch 747's account, so Affinity counts it and 716 never had it."
              >
                {([
                  { v: "ambas", t: "716 + Affinity" },
                  { v: "716", t: "716 only" },
                  { v: "affinity", t: "Affinity" },
                ] as const).map((b, i) => (
                  <button
                    key={b.v}
                    onClick={() => setLente(b.v)}
                    className={`${i > 0 ? "border-l border-[#A6DEFF] " : ""}px-3 py-1 font-medium ${
                      lente === b.v
                        ? "bg-[#A6DEFF]/20 text-[#001A40]"
                        : "bg-white text-slate-500 hover:bg-slate-50"
                    }`}
                  >
                    {b.t}
                  </button>
                ))}
              </span>
            )}
          </div>
        )}

        {/*
          * ⚠ EL ROTULO NO DICE "P&L de Affinity", Y ESO ES LO QUE EVITA LA
          * LECTURA FALSA. Affinity es una LINEA DE NEGOCIO, no una sucursal con
          * estructura: lleva el revenue de sus prestamos, sus costes directos y
          * la nomina de sus account executives, y NADA MAS. El alquiler, el
          * marketing y el resto de la nomina se quedan enteros en la 716 --no se
          * prorratea nada-- asi que su resultado no es "lo que gana Affinity":
          * es lo que deja antes de lo que cuesta sostenerla.
          *
          * Escrito en el bloque y no en un tooltip, porque quien lea la cifra
          * sin esto va a leer una rentabilidad que no existe.
          */}
        {loaded && hayLente && lente !== "ambas" && (
          <div className="mt-2 rounded-lg border border-[#A6DEFF] bg-[#A6DEFF]/10 px-3 py-2 text-[11px] text-[#001A40]">
            {/* ⚠ UNA LINEA, y el resto en el title. El criterio: si hay que leer
                dos lineas para entender una cifra, el texto esta en el sitio
                equivocado -- la cifra se explica por su etiqueta y su posicion.
                Lo largo vivia aqui y se fue al tooltip. */}
            <span
              className="font-semibold"
              title={
                lente === "affinity"
                  ? "Revenue and direct costs of its loans, the LO commission on them, and the payroll of its account executives. Nothing is prorated: rent, marketing and the rest of 716's payroll stay whole on 716, so this is what the line leaves before what it costs to sustain it."
                  : "716's own loans and the general costs in full — rent, marketing and all payroll except the account executives. Nothing was moved out except what Affinity could be identified by."
              }
            >
              {lente === "affinity" ? "Affinity · business line" : "716 · without Affinity"}
            </span>

            {/* La comision NO se repite aqui: su sitio es el cierre de debajo
                de la rejilla, que es donde se lee un total. Dos veces en la
                misma pantalla invita a sumarlas. */}
          </div>
        )}
      </div>

      {/* Title */}
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-xl font-bold text-[#001A40]">P&amp;L</h2>
          {/* The view is named, and the name is on screen. A screenshot of
              this report says which of the four shapes produced it. */}
          <div className="inline-flex rounded-full border border-slate-200 bg-white p-0.5">
            {(Object.keys(SHAPE_LABELS) as HierarchyShape[]).map((sh) => (
              <button
                key={sh}
                onClick={() => setShape(sh)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  shape === sh ? "bg-[#A6DEFF]/30 font-semibold text-[#001A40]" : "text-slate-500 hover:text-[#001A40]"}`}
              >
                {SHAPE_LABELS[sh]}
              </button>
            ))}
          </div>
          <button
            onClick={() => setOpNonOp(v => !v)}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              opNonOp ? "border-sky-200 bg-sky-50 text-sky-900"
                      : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"}`}
          >
            Op / Non-Op
          </button>
          <span className="rounded-full border border-slate-200 bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-500">
            {hierarchyLabel({ shape, opNonOp })}
          </span>
        </div>
        {/* La explicacion de como se navega la rejilla vivia aqui, en cuatro
            lineas sobre la tabla. Se retira: quien usa esta pantalla ya lo
            sabe, y quien no, lo descubre pulsando. Cuatro lineas de texto que
            se leen una vez ocupan sitio todos los dias. */}
      </div>

      {/* Indicator legend — the two dot styles are not self-evident. */}
      <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-slate-200 bg-white px-4 py-2.5 shadow-xs">
        <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-600">
          <MessageSquare size={12} className="text-slate-400" />
          Indicators:
        </span>
        <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-600">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#FF4040]" />
          Note written on this cell
        </span>
        <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-600">
          <span className="inline-block h-1.5 w-1.5 rounded-full border border-[#001A40]/40" />
          Notes from more detailed levels below
        </span>
        <span className="text-[11px] text-slate-400">
          Click a dot to read, edit and add · click the figure to open one level down
        </span>
        {/* Correct behaviour that reads as a fault, so it still gets said — but
            in a chip with the explanation on hover, not a paragraph. The wording
            is unchanged; the space it takes is not. */}
        {shape === "regular" && (
          <span
            title="Regular has no cost center level, so notes anchored to a cost center show as inherited here. Switch to Cost Center to see them on their own row."
            className="cursor-help rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] text-slate-500"
          >
            cost center notes show as inherited here
          </span>
        )}
        {/* A warning, so it is absent when there is nothing to warn about. */}
        <HiddenNotesBadge count={hidden.length} onOpen={() => setPanel({ kind: "hidden" })} />
      </div>

      {/* Per-month loan metrics — the same panel P&L All shows, from the same
          hook and the same request, so the two reports can never disagree about
          how many loans a month had. */}
      {loaded && (
        <LoanMetricsByMonthBar
          data={loanMetrics.data}
          loading={loanMetrics.loading}
          error={loanMetrics.error}
          mode={loanMetrics.mode}
          onModeChange={loanMetrics.setMode}
          showBps={loanMetrics.showBps}
          onShowBpsChange={loanMetrics.setShowBps}
          bpsBase={loanMetrics.bpsBase}
          onBpsBaseChange={loanMetrics.setBpsBase}
          onOpenMonth={(m) => setPanel({ kind: "loans", month: m })}
        />
      )}

      {logCostCenter && (
        <div className="rounded-2xl border border-slate-200 bg-white shadow-xs">
          <button
            onClick={() => setLogOpen(o => !o)}
            className="flex w-full items-center gap-2 px-4 py-2.5 text-left"
          >
            {logOpen
              ? <ChevronDown  size={14} className="shrink-0 text-slate-400" />
              : <ChevronRight size={14} className="shrink-0 text-slate-400" />}
            <MessageSquare size={13} className="shrink-0 text-slate-400" />
            <span className="text-xs font-bold uppercase tracking-wider text-[#001A40]">
              Cost Center Notes Log
            </span>
            <span className="truncate text-xs text-slate-500">— {logCostCenter.name}</span>
          </button>
          {logOpen && (
            <div className="border-t border-slate-200 px-4 py-3">
              <NotesLog
                level="cost_center"
                scope={{ cost_center_id: logCostCenter.id }}
                entityLabel={logCostCenter.name}
                emptyMessage="No notes for this cost center yet."
              />
            </div>
          )}
        </div>
      )}

      {/* Notes whose transaction was removed by a re-upload. Sits right after
          the legend so it is impossible to miss — the whole point is that a
          comment never disappears without the user being told. */}
      <OrphanedNotesPanel
        orphans={orphans}
        transactions={txs}
        onChanged={() => refreshNotes(loadedYears)}
        scopeOrder={SCOPE_ORDER}
        labelFor={defaultScopeLabel}
      />

      {error && (
        <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-600">{error}</p>
      )}

      {!loaded && !loading && (
        <p className="py-10 text-center text-sm text-slate-400">
          Select filters and click Run Report to generate the report.
        </p>
      )}

      {(loaded || loading) && (
        <PivotTableDynamic
          txs={txs}
          splitsMap={splitsMap}
          defaultLevels={levels}
          costCenterFilter={costCenterFilter}
          onDrillCell={(ref) => setPanel({ kind: "cell", ref })}
          payrollBreakdown={loanMetrics.data?.payroll_breakdown ?? null}
          onOpenNotes={(ref) => setPanel({ kind: "notes", ref })}
          // No storageKey: nothing to persist when the hierarchy cannot change,
          // and it keeps a stale saved order from ever resurfacing here.
          lockHierarchy
          enableNotes
          homesiTheme
          bpsBaseByMonth={loanMetrics.bpsBaseByMonth}
          bpsBaseLabel={loanMetrics.bpsBaseLabel}
          notes={notes}
          onNotesChanged={() => refreshNotes(loadedYears)}
          onOrphansChange={setOrphans}
          onResolvedNotes={setPlacedNotes}
          scopeYear={scopeYear}
          scopeBranch={scopeBranch}
          scopeCostCenter={scopeCostCenter}
          loading={loading}
          emptyMessage="No transactions found for the selected filters."
        />
      )}


        <CellDetailModal
          cell={panel?.kind === "cell" ? panel.ref : null}
          notes={placedNotes}
          activeBranches={loadedBranches}
          onClose={() => setPanel(null)}
          onNoteSaved={() => refreshNotes(loadedYears)}
          onOpenNotes={() => setPanel(panel?.kind === "cell" ? { kind: "notes", ref: panel.ref } : null)}
          // Replaces the open cell in place. Still one panel: navigating is not
          // opening a second window, it is the same window on another cell.
          onNavigate={(to) => setPanel({ kind: "cell", ref: to })}
        />

        <NoteWindow
          cell={panel?.kind === "notes" ? panel.ref : null}
          notes={placedNotes}
          scopeOrder={SCOPE_ORDER}
          labelFor={labelFor}
          activeBranches={loadedBranches}
          onClose={() => setPanel(null)}
          onChanged={() => refreshNotes(loadedYears)}
          // The short path out of the short window: same cell, full detail,
          // and the only place a note is written.
          onOpenDetail={() => setPanel(panel?.kind === "notes" ? { kind: "cell", ref: panel.ref } : null)}
        />

        <HiddenNotesModal
          open={panel?.kind === "hidden"}
          notes={hidden}
          onClose={() => setPanel(null)}
        />

        <LoanDetailDrawer
          open={panel?.kind === "loans"}
          month={panel?.kind === "loans" ? panel.month : null}
          year={loadedYears.length === 1 ? Number(loadedYears[0]) : null}
          branches={loadedBranches}
          sources={loadedSources}
          lente={lente}
          onClose={() => setPanel(null)}
        />
    </div>
    </div>

  );
}
