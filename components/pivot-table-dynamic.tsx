"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ArrowUpAZ, ArrowDownAZ, ChevronsUpDown } from "lucide-react";
import {
  ALL_FIELDS,
  FIELD_LABELS,
  buildDynamicPivot,
  expandForOpNonOp,
  stableScopeValue,
  type ExpandedTx,
  type PivotField,
  type PivotNode,
  type TxLeaf,
} from "@/lib/pivot-engine";
import { fanOutBySplits, type SplitEntry } from "@/lib/apply-splits";
import { createPortal } from "react-dom";
import {
  buildNoteIndex,
  cellKey,
  notesForCell,
  resolveNotes,
  type NoteLevel,
  type NoteScope,
  type PLNote,
} from "@/lib/note-scope";
import type { CellRef } from "@/lib/cell-ref";
import { describeLeaves } from "@/lib/cell-breakdown";
import type { PLReportTx } from "@/types";

// ─── Constants ────────────────────────────────────────────────────────────────

const MONTH_ORDER = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

const TOTAL_BG = "#1e3a5f";

const DEPTH_STYLES = [
  { bg: "#eff6ff", text: "text-blue-900",   font: "font-bold",     border: "border-blue-100"   },
  { bg: "#eef2ff", text: "text-indigo-800", font: "font-semibold", border: "border-indigo-100" },
  { bg: "#f9fafb", text: "text-gray-700",   font: "font-semibold", border: "border-gray-100"   },
  { bg: "#ffffff", text: "text-gray-600",   font: "",              border: "border-gray-50"    },
  { bg: "#ffffff", text: "text-gray-500",   font: "",              border: "border-gray-50"    },
] as const;

/**
 * HOMESÍ 2025 depth styling, used by the P&L Notes view.
 *
 * Kept as a separate ramp rather than replacing DEPTH_STYLES so the redesign
 * can land on one report at a time: P&L All keeps its current look until its
 * own pass. Typography carries the nesting (bold navy → semibold slate →
 * light small), which is what makes a long table scannable once colour is
 * reserved for meaning rather than depth.
 */
const HOMESI_DEPTH_STYLES = [
  // Opaque, not rgba: this tone lands on the frozen first column, and a
  // translucent pinned cell shows the month columns sliding underneath it.
  { bg: "#f4f7fa",               text: "text-[#001A40]",  font: "font-bold",     border: "border-slate-200"   },
  { bg: "transparent",           text: "text-slate-800",  font: "font-semibold", border: "border-slate-200/70" },
  { bg: "transparent",           text: "text-slate-800",  font: "font-semibold", border: "border-slate-200/60" },
  { bg: "transparent",           text: "text-slate-600",  font: "",              border: "border-slate-200/50" },
  { bg: "transparent",           text: "text-slate-500",  font: "",              border: "border-slate-200/50" },
] as const;

// Compact executive density: ~6px of vertical padding per data cell, so the
// maximum number of rows fits on one screen.
const numCell =
  "px-3 py-1.5 text-right text-xs font-sans tabular-nums font-medium whitespace-nowrap";

/** Light executive table header. Replaces the solid navy band, which spanned
 *  the full width of a twelve-month report and competed with the figures. */
const TH_LIGHT =
  "bg-slate-100/90 px-3 py-2.5 text-xs font-bold uppercase tracking-wider text-slate-800";

/** Vertical grid rule that keeps adjacent month columns distinct. */
const colRule = "border-r border-slate-200/60";

/**
 * Width of the hierarchy column, in px.
 *
 * A range rather than a single value: the column grows with the content up to
 * the maximum, so short hierarchies stop wasting horizontal space and long
 * descriptions get 140px more before the ellipsis than the old fixed 240 did.
 * Every pixel here is one the month columns cannot use, which is why it is
 * capped at all — the report is read horizontally, category then across months.
 *
 * Labels that still overflow are clipped and carry the full text in a `title`.
 * That costs a hover, and it is a known limitation: there is no way to search
 * the hierarchy, so a row can be hard to locate in a long report.
 */
const FIRST_COL_MIN_W = 240;
const FIRST_COL_MAX_W = 380;

const firstColStyle: React.CSSProperties = {
  minWidth: FIRST_COL_MIN_W, maxWidth: FIRST_COL_MAX_W,
  position: "sticky", left: 0,
};

/**
 * The Total column is pinned to the right so it stays visible as months
 * accumulate. Only the month columns between the two pinned edges scroll.
 */
const totalColStyle: React.CSSProperties = { position: "sticky", right: 0 };

/**
 * Floor for the Total column.
 *
 * It carries the largest figure in the report and, with basis points on, a
 * badge beside it. Without a floor the column collapsed to its header width and
 * clipped both — the word "Total" itself was being cut off.
 */
const totalColSize: React.CSSProperties = { minWidth: 135 };

// ─── Note indicators ──────────────────────────────────────────────────────────

/** Enter delay and leave grace for the hover preview, in ms. */
const HOVER_IN_MS  = 400;
const HOVER_OUT_MS = 200;

/**
 * True only where hovering is a gesture of its own.
 *
 * A touch screen reports a hover on the tap that precedes the click, so without
 * this the preview would open under the finger on the way to the figure and the
 * tap would land on whatever it had just covered. On those devices the dot has
 * no preview at all: a tap opens the notes window.
 */
function useFinePointer(): boolean {
  const [fine, setFine] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(hover: hover) and (pointer: fine)");
    const on = () => setFine(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return fine;
}

/**
 * The note indicator: a real button, not a decorated span.
 *
 * It has a job of its own now — the figure beside it opens the movements, the
 * dot opens the notes — so it has to be reachable and announced as a control.
 * The mark stays 6px because the report is read as a column of figures and a
 * bigger one would compete with them; the button around it is 20px and
 * transparent, pulled back with negative margins so those extra pixels cost the
 * row no height and the amounts stay exactly where they were.
 */
function NoteDot({
  isDirect,
  onOpen,
  preview,
}: {
  isDirect: boolean;
  onOpen: () => void;
  /** Read lazily: resolving every cell's notes up front would cost a pass over
   *  the whole note set per rendered figure, and almost none are ever hovered. */
  preview: () => PLNote[];
}) {
  const fine  = useFinePointer();
  const ref   = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pop, setPop] = useState<{ x: number; y: number; notes: PLNote[] } | null>(null);

  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  useEffect(() => clear, []);

  const enter = () => {
    if (!fine) return;
    clear();
    // Long enough that a pointer crossing the cell on its way elsewhere never
    // opens it; short enough that stopping on the dot feels like an answer.
    timer.current = setTimeout(() => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      setPop({ x: r.left + r.width / 2, y: r.bottom, notes: preview() });
    }, HOVER_IN_MS);
  };

  const leave = () => {
    if (!fine) return;
    clear();
    // Grace on the way out, so the pointer can travel from the dot into the
    // preview without it closing underneath.
    timer.current = setTimeout(() => setPop(null), HOVER_OUT_MS);
  };

  const first = pop?.notes[0];
  const POP_W = 300;

  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={(e) => { e.stopPropagation(); clear(); setPop(null); onOpen(); }}
        onMouseEnter={enter}
        onMouseLeave={leave}
        onFocus={enter}
        onBlur={leave}
        aria-label={isDirect ? "Read the note on this cell" : "Read notes from more detailed levels"}
        // 20px of target around a 6px mark; the negative margins hand the 14px
        // difference back to the layout so no row grows.
        className="relative -mx-[7px] -my-2 inline-flex h-5 w-5 shrink-0 items-center justify-center align-middle"
      >
        <span
          aria-hidden
          className={
            isDirect
              ? "inline-block h-1.5 w-1.5 rounded-full bg-[#FF4040]"
              : "inline-block h-1.5 w-1.5 rounded-full border border-[#001A40]/40"
          }
        />
      </button>

      {/* Portalled to the body on purpose. The cell it belongs to sits inside a
          scroll container full of sticky columns, each of which is its own
          stacking context — anchored there, the preview would be clipped by one
          of them and painted underneath the others. */}
      {pop && typeof document !== "undefined" && createPortal(
        <div
          onMouseEnter={clear}
          onMouseLeave={leave}
          style={{
            position: "fixed",
            width: POP_W,
            top: pop.y + 8,
            // Clamped to the viewport: the dot lands in the last month column as
            // often as the first, and a preview half off-screen is no preview.
            left: Math.min(Math.max(8, pop.x - POP_W / 2), Math.max(8, window.innerWidth - POP_W - 8)),
            zIndex: 80,
          }}
          className="rounded-xl border border-slate-200 bg-white p-3 text-left shadow-xl"
        >
          {first ? (
            <>
              <p className="line-clamp-3 whitespace-pre-wrap text-[11px] text-slate-700">
                {first.note_text}
              </p>
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="truncate text-[10px] text-slate-400">
                  {first.author ?? "—"}
                  {pop.notes.length > 1 ? ` · +${pop.notes.length - 1} more` : ""}
                </span>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setPop(null); onOpen(); }}
                  className="shrink-0 text-[10px] font-semibold text-[#FF4040] hover:underline"
                >
                  View note{pop.notes.length > 1 ? "s" : ""}
                </button>
              </div>
            </>
          ) : (
            <p className="text-[11px] italic text-slate-400">No note text.</p>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

/**
 * Wraps a numeric cell so it can be clicked to open its notes.
 *
 * Two indicator styles, because roll-up means the upper rows of the report
 * would otherwise be a wall of identical dots: a solid dot marks a note written
 * on this exact cell, a hollow one marks notes inherited from levels below.
 */
function NoteCellContent({
  text,
  hasNote,
  isDirect,
  onOpenNotes,
  previewNotes,
  badgeClass = "",
  bps,
  reserveBpsSlot = false,
}: {
  text: string;
  hasNote: boolean;
  isDirect: boolean;
  /** Opens the notes window for this cell. Absent on rows that carry none. */
  onOpenNotes?: () => void;
  previewNotes?: () => PLNote[];
  /** Negative-total badge in the HOMESÍ theme; empty elsewhere. */
  badgeClass?: string;
  /** Already-formatted basis points, rendered beside the figure. */
  bps?: string | null;
  /**
   * Hold the badge's width open on a row that has no basis points of its own.
   * Total Income has no bps, and without the reserved slot its figures would
   * sit a badge-width to the right of every row beneath them.
   */
  reserveBpsSlot?: boolean;
}) {
  return (
    // Inline, never stacked. A second line under the figure doubles the height
    // of every row in the report the moment bps are switched on, which undoes
    // the compact density the whole grid is built around.
    <span className="flex w-full flex-row items-center justify-end gap-1.5 whitespace-nowrap">
      <span className={`inline-flex items-center justify-end gap-1 ${badgeClass}`}>
        {hasNote && onOpenNotes && previewNotes && (
          <NoteDot isDirect={isDirect} onOpen={onOpenNotes} preview={previewNotes} />
        )}
        {text}
      </span>
      {bps != null ? (
        // Plain muted text, no fill and no border. Boxed, it repeated a framed
        // chip on every figure of every month and the grid read as saturated
        // before a single number had been taken in.
        //
        // Fixed width all the same, and that is not decoration: "—" and
        // "123.4 bps" have different natural widths, so a content-width element
        // would leave each figure in a slightly different place and the column
        // of amounts would zig-zag down the page.
        <span className="ml-1 inline-block w-[52px] shrink-0 text-left font-mono text-[10px] font-normal text-slate-400">
          {/* "— bps" would read as a unit on a missing value, so the dash goes
              on its own when there is nothing to divide by. */}
          {bps === "—" ? "—" : `${bps} bps`}
        </span>
      ) : reserveBpsSlot ? (
        <span aria-hidden className="ml-1 inline-block w-[52px] shrink-0" />
      ) : null}
    </span>
  );
}

/**
 * Basis points of a figure against the month's loan volume.
 *
 * Returns null when there is nothing to divide by. A zero would be a lie: the
 * answer is not "0 bps", it is "not computable" — the month has no loan volume
 * in the chosen base, or the branch filter selects branches that carry no loans
 * at all. The caller renders a dash, and the strip above the table explains
 * which of the two it is.
 *
 * One decimal. With a base near $12M a single bp is about $1,200, so integers
 * throw away real resolution on small lines; two decimals is noise. A figure
 * that is non-zero but rounds below 0.1 shows as "<0.1" rather than "0.0", so a
 * small real number never reads as nothing.
 *
 * The sign is kept. A P&L is mostly negative at detail level, so most of these
 * are negative — and the bps sits directly under the figure it comes from, where
 * an unsigned value would contradict the number above it.
 */
function fmtBps(value: number | undefined, base: number | undefined): string | null {
  if (!base) return null;
  const v = value ?? 0;
  const bps = (v / base) * 10000;
  if (v !== 0 && Math.abs(bps) < 0.05) return bps < 0 ? "<-0.1" : "<0.1";
  return bps.toFixed(1);
}

/** Everything the recursive renderer needs beyond the nodes themselves. */
interface RenderCtx {
  months: string[];
  exp: Set<string>;
  toggle: (k: string) => void;
  descSort: "asc" | "desc" | null;
  /**
   * Off for every report whose hierarchy the user can reorder. In those the
   * same note would surface on a different-looking row depending on how the
   * pivot happens to be arranged that day, so the cells stay read-only and no
   * indicator is drawn. Only the fixed-hierarchy P&L Notes view turns this on.
   */
  notesOn: boolean;
  noteAny: Set<string>;
  noteDirect: Set<string>;
  /** Opens the notes-only window for a cell. */
  openNotes: (ref: CellRef) => void;
  /** Notes visible on a cell, resolved on demand for the hover preview. */
  notesAt: (scope: NoteScope) => PLNote[];
  baseScope: NoteScope;
  /** HOMESÍ 2025 styling: zebra striping, sky hover, typographic depth ramp. */
  homesi: boolean;
  /** Loan volume per month for the chosen bps base. Null turns bps off. */
  bpsBase: Record<string, number> | null;
  /** Sum of the displayed months' bases, for the Total column — its denominator
   *  is not any single month but the whole span the column covers. */
  bpsBaseTotal: number;
  /**
   * Opens the detail window for a cell. When set, the tree stops materialising
   * transaction rows: the breakdown happens in that window instead.
   */
  onDrillCell: ((ref: CellRef) => void) | null;
}

/**
 * Turns a node and a period into the cell both windows are opened with.
 *
 * The breakdown comes from the node's own children, not from a second query.
 * That is deliberate: the figures in the window are then the figures in the
 * report by construction, rather than by two computations agreeing — and it is
 * what makes a cost centre no more expensive to open than a GL, because neither
 * one reaches past the level immediately below it.
 */
function buildCellRef(opts: {
  scope: NoteScope;
  trail: readonly string[];
  month: string | null;
  amount: number;
  level: NoteLevel;
  levelLabel: string;
  valueLabel: string;
  /** Children of the node. Empty or absent means the deepest level. */
  children?: readonly PivotNode[];
  /** Rows of the node, used only when it has no children. */
  leaves?: readonly TxLeaf[];
  /** The cell's own figure per month, for the heading under a month filter. */
  byMonth?: Record<string, number>;
}): CellRef {
  const { scope, trail, month, amount, children, leaves } = opts;
  const withMonth = (s: NoteScope): NoteScope => (month ? { ...s, month } : s);
  const kids = children ?? [];

  /**
   * The level below the deepest cell, grouped from that cell's own rows.
   *
   * Those rows have already been prorated by the cost-centre split and
   * expanded for op/non-op, so these figures add up to the heading above them.
   * Asking the server instead would answer from the raw assignment, and the
   * two do not reconcile — measured on CC01 in June, 7 of 18 GL cells.
   */
  // Extracted to lib/cell-breakdown.ts rather than written here: it is data
  // logic, not rendering, and inside a .tsx component it can only be exercised
  // by mounting React. The one bug on this branch that no verification caught —
  // the view switch that changed nothing — was exactly of that kind.
  const descriptions = !kids.length && leaves?.length
    ? describeLeaves(leaves, scope, month)
    : null;
  return {
    scope:      withMonth(scope),
    breadcrumb: month ? [...trail, month] : [...trail],
    title:      trail[trail.length - 1] ?? "Total Income",
    month,
    amount,
    byMonth: opts.byMonth ?? {},
    self: {
      level:      opts.level,
      levelLabel: opts.levelLabel,
      valueLabel: opts.valueLabel,
      scope:      withMonth(scope),
      amount,
    },
    children: kids.length
      ? kids.map((c) => ({
          level:      c.field as NoteLevel,
          levelLabel: FIELD_LABELS[c.field as PivotField] ?? c.field,
          valueLabel: c.label,
          scope:      withMonth({ ...scope, ...c.scope }),
          amount:     month ? (c.byMonth[month] ?? 0) : c.total,
        }))
      : null,
    childLevelLabel: kids.length
      ? FIELD_LABELS[kids[0].field as PivotField] ?? kids[0].field
      : null,
    // Calendar order, and only the months this cell has — the columns of the
    // trend matrix.
    months: MONTH_ORDER.filter((m) => leaves?.some((l) => l.month === m)),
    descriptions,
  };
}

/**
 * Row background for the HOMESÍ theme.
 *
 * Zebra striping cannot be done with even:/odd: utilities here because the rows
 * are pushed into one flat array across recursion levels, so a row's parity is
 * only known at build time — it is threaded explicitly instead.
 */
function homesiRowBg(index: number): string {
  // even:bg-white / odd:bg-slate-50/50, written as an inline colour rather than
  // a class because the sticky first and Total columns must repaint the exact
  // same tone — a pinned cell that is even slightly transparent lets the
  // scrolling month columns show through it.
  //
  // Which is exactly what this used to do: the odd stripe was
  // rgba(248,250,252,0.5), so the frozen first column bled the months passing
  // underneath it on every other row. #fcfdfe is that same colour resolved
  // against white, opaque, so the stripe looks identical and the pinned cells
  // actually cover what is behind them.
  return index % 2 === 0 ? "#ffffff" : "#fcfdfe";
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtM(v: number | undefined): string {
  if (!v) return "—";
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function mvCls(v: number | undefined): string {
  if (!v) return "text-gray-300";
  return v > 0 ? "text-emerald-700" : "text-red-600";
}

/**
 * HOMESÍ value colouring. Positives stay neutral so the eye is not pulled to
 * every ordinary figure; zeros recede; negatives are tinted, and only totals
 * and subtotals get the rose badge — a P&L is mostly negative at detail level,
 * so badging every row would paint the whole table.
 */
function homesiValueCls(v: number | undefined): string {
  // Muted zero state: "—" and 0.00 recede rather than competing with real
  // figures for attention.
  if (!v) return "text-slate-300 font-normal";
  // Red by exception. A positive figure is the ordinary case in a report and
  // gets no colour of its own; only a loss is worth an eye movement.
  return v < 0 ? "text-rose-600 font-medium" : "text-[#001A40] font-medium";
}

/**
 * Badge for the Net Income closing rows — and only those.
 *
 * Every hierarchy row used to get this treatment, which meant a report was a
 * field of emerald pills on every positive figure. A badge that appears on
 * hundreds of rows tells the reader nothing; reserved for the two bottom lines
 * it tells them where the answer is.
 */
function netIncomeBadge(v: number | undefined): string {
  if (v == null || v === 0) return "";
  return v < 0
    ? "bg-rose-50 text-rose-700 font-bold px-1.5 py-0.5 rounded"
    : "bg-emerald-50 text-emerald-800 font-bold px-1.5 py-0.5 rounded";
}

/**
 * Total Income banner values.
 *
 * A loss gets the pastel rose badge; everything else stays plain navy, set on
 * the cell itself. No emerald here even though netIncomeBadge has one: this is
 * the top line, not the bottom line, and it is always on screen — badging its
 * ordinary state would make the badge mean "this row exists".
 */
function grandTotalBadge(v: number | undefined): string {
  return v != null && v < 0
    ? "text-rose-700 bg-rose-50/80 px-2 py-0.5 rounded"
    : "";
}

function mvClsLight(v: number | undefined): string {
  if (!v) return "text-white/40";
  return v > 0 ? "text-emerald-300" : "text-red-300";
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface PivotTableDynamicProps {
  txs: PLReportTx[];
  /** Pass the raw splits map so the component can fan-out when "Cost Center" enters the hierarchy. */
  splitsMap?: Map<string, SplitEntry[]>;
  defaultLevels: PivotField[];
  availableFields?: PivotField[];
  storageKey?: string;
  loading?: boolean;
  emptyMessage?: string;
  /**
   * Turns on click-to-note and the cell indicators. Off by default, and only
   * safe to enable when `lockHierarchy` is set: in a reorderable pivot the same
   * note lands on a differently-shaped row depending on how the user arranged
   * the levels that day, so the icon appears to move while the underlying
   * figure has not changed.
   */
  enableNotes?: boolean;
  /** Hides the "Pivot by:" bar so the hierarchy cannot be reordered. */
  lockHierarchy?: boolean;
  /** HOMESÍ 2025 styling. Opt-in so the redesign can roll out one report at a
   *  time instead of changing every pivot at once. */
  homesiTheme?: boolean;
  /** Notes for the loaded report. Fetched by the page, not by this component,
   *  so adding a note never re-downloads the transactions. */
  notes?: readonly PLNote[];
  /** Called after a note is created or deleted, so the page can refetch them. */
  onNotesChanged?: () => void;
  /** Reports transaction-level notes whose transaction no longer exists, so the
   *  page can show them instead of letting them disappear. */
  onOrphansChange?: (orphans: PLNote[]) => void;
  /**
   * The notes as this table resolved them, handed back so the windows the page
   * owns read the same set the indicators were drawn from.
   *
   * Not a nicety: a transaction note is stored as {transaction_id} alone, which
   * satisfies no cell's containment test. Only the re-anchoring done here makes
   * it roll up, so a window given the raw notes would show every aggregate note
   * and silently omit every transaction one.
   */
  onResolvedNotes?: (notes: PLNote[]) => void;
  /** The single year the report covers, when unambiguous. Omitted for
   *  multi-year loads, where a month column merges several years and the cell
   *  genuinely has no single period. */
  scopeYear?: number;
  /**
   * Loan volume by month for the selected bps base, already resolved by the
   * page. Passing resolved numbers rather than raw metrics keeps the corporate
   * branch rule (700) in one place — the endpoint decides, this component only
   * draws. Null or absent turns the annotation off.
   */
  bpsBaseByMonth?: Record<string, number> | null;
  /** Name of the chosen base, printed in the table header so a screenshot of
   *  the grid alone still says what the bps were computed against. */
  bpsBaseLabel?: string | null;
  /**
   * Cost centres to keep, as the stable values stableScopeValue produces —
   * a cost_center_id, or "__unassigned__" / "__conflict__".
   *
   * Filtering here rather than in the caller is what keeps a single data
   * path. The page used to pre-fan its rows and then withhold splitsMap so
   * they would not be fanned twice; that left the notes code reading
   * already-duplicated transactions through a branch nothing had exercised.
   * Now the table always receives raw txs plus splitsMap, fans them itself,
   * and drops what the filter excludes — so the rows notes are resolved
   * against are the same rows in every mode.
   */
  costCenterFilter?: readonly string[] | null;
  /**
   * Opens the detail window for a figure — its movements, and the composer
   * where a note's anchor level is chosen explicitly.
   *
   * Supplying it also ends the tree at the last hierarchy level: the transaction
   * rows below it are not drawn, because which description makes them readable
   * depends on the account and no fixed level can answer that. The window asks
   * instead.
   */
  onDrillCell?: (ref: CellRef) => void;
  /** Opens the notes-only window. Reached from the dot, never from a figure. */
  onOpenNotes?: (ref: CellRef) => void;
}

// ─── Recursive renderer (mutates `rows` for performance) ─────────────────────

function renderPivotNodes(
  nodes: PivotNode[],
  depth: number,
  rows: React.ReactNode[],
  pathPrefix: string,
  labelPath: string[],
  ctx: RenderCtx,
) {
  const { months, exp, toggle, descSort, homesi } = ctx;
  const ramp = homesi ? HOMESI_DEPTH_STYLES : DEPTH_STYLES;
  const ds = ramp[Math.min(depth, ramp.length - 1)];
  const pl = depth * 16 + 8;
  // Sticky first column: opaque so month values cannot scroll underneath it.
  const stickyCol = homesi
    ? "sticky left-0 z-20 border-r-2 border-slate-200 shadow-xs"
    : "";
  const rowHover = homesi
    ? "hover:bg-[#A6DEFF]/25 transition-colors cursor-pointer"
    : "";
  // Pinned cells must be opaque or the scrolling months show through them.
  // Detail rows are white outside the HOMESÍ theme and zebra-striped within it.
  const rowBgFor = (idx: number) => (homesi ? homesiRowBg(idx) : "#ffffff");

  /** Numeric cell for a leaf transaction row. */
  const leafCells = (t: TxLeaf, nodeScope: NoteScope, trail: string[]) => {
    // Key scope, month excluded — cellKey adds the period as its suffix.
    const leafScope: NoteScope = { ...nodeScope, transaction_id: t.txId };
    const label = t.desc ?? t.vendor ?? "—";
    // A transaction has nothing below it, so its window is the figure and the
    // notes on it — there is no next level to break down.
    const refFor = (month: string | null, amount: number) =>
      buildCellRef({
        scope: leafScope, trail: [...trail, label], month, amount,
        level: "transaction", levelLabel: "Transaction", valueLabel: label,
        byMonth: { [t.month]: t.mvmt },
      });
    const open      = (m: string | null, a: number) => ctx.onDrillCell?.(refFor(m, a));
    const openNotes = (m: string | null, a: number) => ctx.openNotes(refFor(m, a));

    return (
      <>
        {months.map((m) => {
          const key = cellKey(leafScope, m);
          const shown = m === t.month;
          const clickable = ctx.notesOn && shown;
          // Detail rows never carry the negative badge — plain tinted text only.
          const valueCls = homesi ? homesiValueCls(t.mvmt) : mvCls(t.mvmt);
          return (
            <td
              key={m}
              onClick={clickable ? (e) => { e.stopPropagation(); open(m, t.mvmt); } : undefined}
              className={`${numCell} ${homesi ? colRule : ""} ${shown ? valueCls : homesi ? "text-slate-300 font-normal" : "text-gray-200"} ${clickable ? "cursor-pointer" : ""}`}
            >
              {shown && (
                <NoteCellContent
                  text={fmtM(t.mvmt)}
                  hasNote={ctx.notesOn && ctx.noteAny.has(key)}
                  isDirect={ctx.noteDirect.has(key)}
                  onOpenNotes={() => openNotes(m, t.mvmt)}
                  previewNotes={() => ctx.notesAt({ ...leafScope, month: m })}
                  bps={ctx.bpsBase ? fmtBps(t.mvmt, ctx.bpsBase[m]) ?? "—" : null}
                />
              )}
            </td>
          );
        })}
        <td
          onClick={ctx.notesOn ? (e) => { e.stopPropagation(); open(null, t.mvmt); } : undefined}
          style={{ ...totalColStyle, ...totalColSize, zIndex: 9, backgroundColor: rowBgFor(rows.length) }}
          className={`${numCell} text-[10px] ${homesi ? homesiValueCls(t.mvmt) : mvCls(t.mvmt)} border-l ${homesi ? "border-slate-200" : "border-gray-100"} ${ctx.notesOn ? "cursor-pointer" : ""}`}
        >
          <NoteCellContent
            text={fmtM(t.mvmt)}
            hasNote={ctx.notesOn && ctx.noteAny.has(cellKey(leafScope, null))}
            isDirect={ctx.noteDirect.has(cellKey(leafScope, null))}
            onOpenNotes={() => openNotes(null, t.mvmt)}
            previewNotes={() => ctx.notesAt(leafScope)}
            bps={ctx.bpsBase ? fmtBps(t.mvmt, ctx.bpsBaseTotal) ?? "—" : null}
          />
        </td>
      </>
    );
  };

  for (const node of nodes) {
    const nodeKey    = `${pathPrefix}|${node.field}:${node.key}`;
    const isOpen     = exp.has(nodeKey);
    const isOpNonOp  = node.field === "op_nonop";
    const isOp       = isOpNonOp && node.key === "Operational";
    const isNonOp    = isOpNonOp && node.key === "Non-Operational";
    // With the modal wired, a node whose only content is transactions has
    // nothing to open — offering a chevron that reveals nothing is worse than
    // no chevron.
    const hasContent = node.children.length > 0 ||
      (node.txLeaves.length > 0 && !ctx.onDrillCell);
    const isDrillable = !!ctx.onDrillCell;
    const canToggle  = hasContent || isOpNonOp;

    // Flat (no-level) case: render leaf rows directly without a group header
    if (node.key === "__flat__") {
      const flatLeaves = descSort
        ? [...node.txLeaves].sort((a, b) => {
            const dir = descSort === "asc" ? 1 : -1;
            return dir * (a.desc ?? "").localeCompare(b.desc ?? "", undefined, { sensitivity: "base" });
          })
        : node.txLeaves;
      const flatScope: NoteScope = { ...ctx.baseScope, ...node.scope };
      for (const t of flatLeaves) {
        rows.push(
          <tr
            key={`flat|leaf:${t.id}`}
            className={`group border-b ${homesi ? `border-slate-200/50 ${rowHover}` : "border-gray-50 hover:bg-slate-50"}`}
            style={homesi ? { backgroundColor: homesiRowBg(rows.length) } : undefined}
          >
            <td
              title={t.desc ?? t.vendor ?? undefined}
              style={{ ...firstColStyle, paddingLeft: 8, zIndex: 20, backgroundColor: rowBgFor(rows.length) }}
              className={`overflow-hidden text-ellipsis whitespace-nowrap py-1.5 pr-3 ${homesi ? `text-xs font-normal text-slate-600 ${stickyCol} group-hover:bg-[#A6DEFF]/25` : "text-[10px] text-gray-500 group-hover:bg-slate-50"}`}
            >
              {t.desc ?? t.vendor ?? "—"}
            </td>
            {leafCells(t, flatScope, labelPath)}
          </tr>
        );
      }
      continue;
    }

    // Determine row styling
    let rowBg: string;
    let firstTdExtra: React.CSSProperties = {};
    let textClass: string;
    let fontClass: string;
    let borderClass: string;

    if (isOp) {
      rowBg       = "#f0fdf4";
      firstTdExtra = { borderLeft: "3px solid #16a34a" };
      textClass   = "text-emerald-800";
      fontClass   = "font-bold";
      borderClass = "border-emerald-100";
    } else if (isNonOp) {
      rowBg       = "#f8fafc";
      firstTdExtra = { borderLeft: "3px solid #64748b" };
      textClass   = "text-slate-700";
      fontClass   = "font-bold";
      borderClass = "border-slate-200";
    } else {
      rowBg       = ds.bg;
      textClass   = ds.text;
      fontClass   = ds.font;
      borderClass = ds.border;
    }

    const nodeScope: NoteScope = { ...ctx.baseScope, ...node.scope };
    const nodeTrail = [...labelPath, node.label];
    const refFor = (month: string | null, amount: number) =>
      buildCellRef({
        scope: nodeScope, trail: nodeTrail, month, amount,
        level:      node.field as NoteLevel,
        levelLabel: FIELD_LABELS[node.field as PivotField] ?? node.field,
        valueLabel: node.label,
        children:   node.children,
        leaves:     node.txLeaves,
        byMonth:    node.byMonth,
      });
    const openDetail = (month: string | null, amount: number) =>
      ctx.onDrillCell?.(refFor(month, amount));
    const openNodeNotes = (month: string | null, amount: number) =>
      ctx.openNotes(refFor(month, amount));

    // Depth-2+ HOMESÍ rows sit on the zebra stripe; depth 0/1 keep the tinted
    // band from the ramp so the top of the hierarchy still reads as a header.
    const homesiBg = ds.bg === "transparent" ? homesiRowBg(rows.length) : ds.bg;
    const effectiveBg = homesi ? homesiBg : rowBg;

    rows.push(
      <tr
        key={nodeKey}
        className={`group border-b ${borderClass} ${canToggle || isDrillable ? "cursor-pointer" : ""} ${homesi ? rowHover : ""}`}
        style={{ backgroundColor: effectiveBg }}
        // A GL row has nothing left to expand, so its row click is free for the
        // breakdown of the whole row. Every figure in it opens the same window
        // for its own month, which is the gesture that actually gets used.
        onClick={() => {
          if (canToggle) toggle(nodeKey);
          else if (isDrillable) openDetail(null, node.total);
        }}
      >
        <td
          title={node.label}
          style={{ ...firstColStyle, backgroundColor: effectiveBg, paddingLeft: pl, zIndex: 20, ...firstTdExtra }}
          className={`overflow-hidden text-ellipsis whitespace-nowrap py-1.5 pr-3 ${textClass} ${fontClass} ${homesi ? `text-xs ${stickyCol}` : "text-[11px]"}`}
        >
          <span className="inline-flex items-center gap-1">
            {canToggle
              ? (isOpen
                  ? <ChevronDown  size={10} className="shrink-0" />
                  : <ChevronRight size={10} className="shrink-0" />)
              : <span className="inline-block w-[10px]" />}
            {node.label}
          </span>
        </td>
        {months.map(m => {
          const key = cellKey(nodeScope, m);
          const v = node.byMonth[m];
          return (
            <td
              key={m}
              // One gesture, one meaning: the figure opens what is behind it.
              // It used to open the notes instead, which left the movements
              // with nowhere to go and made the anchor level of a new note a
              // consequence of which row the reader happened to click.
              onClick={isDrillable ? (e) => { e.stopPropagation(); openDetail(m, v ?? 0); } : undefined}
              className={`${numCell} ${homesi ? colRule : ""} ${fontClass} ${homesi ? homesiValueCls(v) : mvCls(v)} ${isDrillable ? "cursor-pointer" : ""}`}
            >
              {/* No badge on hierarchy rows. Colour carries the sign; the pill
                  is reserved for the Net Income closing lines. */}
              <NoteCellContent
                text={fmtM(v)}
                hasNote={ctx.notesOn && ctx.noteAny.has(key)}
                isDirect={ctx.noteDirect.has(key)}
                onOpenNotes={() => openNodeNotes(m, v ?? 0)}
                previewNotes={() => ctx.notesAt({ ...nodeScope, month: m })}
                bps={ctx.bpsBase ? fmtBps(v, ctx.bpsBase[m]) ?? "—" : null}
              />
            </td>
          );
        })}
        <td
          onClick={isDrillable ? (e) => { e.stopPropagation(); openDetail(null, node.total); } : undefined}
          style={{ ...totalColStyle, ...totalColSize, zIndex: 9, backgroundColor: effectiveBg }}
          className={`${numCell} ${fontClass} ${homesi ? homesiValueCls(node.total) : mvCls(node.total)} border-l ${homesi ? "border-slate-200" : "border-gray-100"} ${isDrillable ? "cursor-pointer" : ""}`}
        >
          <NoteCellContent
            text={fmtM(node.total)}
            hasNote={ctx.notesOn && ctx.noteAny.has(cellKey(nodeScope, null))}
            isDirect={ctx.noteDirect.has(cellKey(nodeScope, null))}
            onOpenNotes={() => openNodeNotes(null, node.total)}
            previewNotes={() => ctx.notesAt(nodeScope)}
            bps={ctx.bpsBase ? fmtBps(node.total, ctx.bpsBaseTotal) ?? "—" : null}
          />
        </td>
      </tr>
    );

    if (!isOpen) continue;

    // Recurse into children
    if (node.children.length > 0) {
      renderPivotNodes(node.children, depth + 1, rows, nodeKey, nodeTrail, ctx);
    }

    // Leaf transaction rows. Suppressed when a drill-down modal is wired:
    // the tree ends at GL and the breakdown happens there instead.
    if (node.txLeaves.length > 0 && !ctx.onDrillCell) {
      const leafPl = (depth + 1) * 16 + 8;
      const sortedLeaves = descSort
        ? [...node.txLeaves].sort((a, b) => {
            const dir = descSort === "asc" ? 1 : -1;
            return dir * (a.desc ?? "").localeCompare(b.desc ?? "", undefined, { sensitivity: "base" });
          })
        : node.txLeaves;
      for (const t of sortedLeaves) {
        rows.push(
          <tr
            key={`${nodeKey}|leaf:${t.id}`}
            className={`group border-b ${homesi ? `border-slate-200/50 ${rowHover}` : "border-gray-50 hover:bg-slate-50"}`}
            style={homesi ? { backgroundColor: homesiRowBg(rows.length) } : undefined}
          >
            <td
              title={t.desc ?? t.vendor ?? undefined}
              style={{ ...firstColStyle, paddingLeft: leafPl, zIndex: 20, backgroundColor: rowBgFor(rows.length) }}
              className={`overflow-hidden text-ellipsis whitespace-nowrap py-1.5 pr-3 ${homesi ? `text-xs font-normal text-slate-600 ${stickyCol} group-hover:bg-[#A6DEFF]/25` : "text-[10px] text-gray-400 group-hover:bg-slate-50"}`}
            >
              {t.desc ?? t.vendor ?? "—"}
            </td>
            {leafCells(t, nodeScope, nodeTrail)}
          </tr>
        );
      }
    }

    // Op/NonOp empty state
    if (isOpNonOp && !hasContent) {
      const emptyPl  = (depth + 1) * 16 + 8;
      const emptyMsg = isOp
        ? "No Operational transactions yet."
        : "No Non-Operational transactions yet — classify rules or assignments as Non-Operational to see them here.";
      rows.push(
        <tr key={`${nodeKey}|empty`} className={`border-b ${isOp ? "border-emerald-100" : "border-slate-200"}`}>
          <td
            colSpan={months.length + 2}
            style={{ paddingLeft: emptyPl, backgroundColor: isOp ? "#f0fdf4" : "#f8fafc" }}
            className="py-3 text-[11px] italic text-gray-400"
          >
            {emptyMsg}
          </td>
        </tr>
      );
    }

    // Op/NonOp Net Income footer (when has content)
    if (isOpNonOp && hasContent) {
      // Neutral fill in the HOMESÍ theme. The Operational footer used to be a
      // full-width emerald band, which is the loudest green in the report and
      // would swallow the pill that now carries the actual result. The 3px left
      // rule still marks which of the two closings this is.
      const footerBg    = homesi ? "#f1f5f9" : isOp ? "#dcfce7" : "#f1f5f9";
      const footerAcc   = isOp ? "#16a34a" : "#64748b";
      const footerText  = homesi ? "text-[#001A40]" : isOp ? "text-emerald-900" : "text-slate-800";
      const footerLabel = isOp ? "Net Income (Operational)" : "Net Income (Non-Operational)";
      rows.push(
        <tr key={`${nodeKey}|net`} style={{ backgroundColor: footerBg }} className="border-b border-gray-200">
          <td
            title={footerLabel}
            style={{ ...firstColStyle, backgroundColor: footerBg, borderLeft: `3px solid ${footerAcc}`, paddingLeft: pl + 16, zIndex: 20 }}
            className={`pr-3 py-1.5 text-[11px] font-extrabold ${footerText} whitespace-nowrap truncate`}
          >
            {footerLabel}
          </td>
          {months.map(m => (
            <td key={m} className={`${numCell} font-extrabold ${homesi ? homesiValueCls(node.byMonth[m]) : mvCls(node.byMonth[m])}`}>
              <NoteCellContent
                text={fmtM(node.byMonth[m])}
                hasNote={false}
                isDirect={false}
                badgeClass={homesi ? netIncomeBadge(node.byMonth[m]) : ""}
                bps={ctx.bpsBase ? fmtBps(node.byMonth[m], ctx.bpsBase[m]) ?? "—" : null}
              />
            </td>
          ))}
          <td
            style={{ ...totalColStyle, ...totalColSize, zIndex: 9, backgroundColor: footerBg }}
            className={`${numCell} font-extrabold ${homesi ? homesiValueCls(node.total) : mvCls(node.total)} border-l border-gray-100`}
          >
            <NoteCellContent
              text={fmtM(node.total)}
              hasNote={false}
              isDirect={false}
              badgeClass={homesi ? netIncomeBadge(node.total) : ""}
              bps={ctx.bpsBase ? fmtBps(node.total, ctx.bpsBaseTotal) ?? "—" : null}
            />
          </td>
        </tr>
      );
    }
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

function readStorage(key: string, defaultLevels: PivotField[]): PivotField[] {
  try {
    if (typeof window === "undefined") return defaultLevels;
    const raw = localStorage.getItem(key);
    if (!raw) return defaultLevels;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaultLevels;
    const valid = new Set<string>(ALL_FIELDS);
    // Discard entirely if any item is unrecognised (field was renamed/removed)
    if (!parsed.every((item): item is PivotField => typeof item === "string" && valid.has(item))) {
      return defaultLevels;
    }
    if (parsed.length === 0) return defaultLevels;
    return parsed;
  } catch {
    return defaultLevels;
  }
}

export function PivotTableDynamic({
  txs,
  splitsMap,
  defaultLevels,
  availableFields = ALL_FIELDS,
  storageKey,
  loading,
  emptyMessage = "No data",
  enableNotes = false,
  lockHierarchy = false,
  homesiTheme = false,
  notes,
  onNotesChanged,
  onOrphansChange,
  onResolvedNotes,
  scopeYear,
  bpsBaseByMonth,
  bpsBaseLabel,
  costCenterFilter,
  onDrillCell,
  onOpenNotes,
}: PivotTableDynamicProps) {
  /**
   * The hierarchy this table is actually drawing.
   *
   * Only the reorderable pivot owns it. With `lockHierarchy` the prop is the
   * truth and is read straight through — it is not copied into state, because
   * that copy is exactly what broke: the initialiser below is lazy, so it ran
   * once on mount and every later change to `defaultLevels` was ignored.
   * Switching to the Cost Center view rebuilt the tree, correctly, out of the
   * levels the page had been mounted with. Run Report did not help: it changes
   * the transactions, not the levels, so the memo re-ran and produced the same
   * shape again.
   *
   * Derived rather than synced with an effect on purpose. An effect would make
   * the two agree one render later; deriving makes it impossible for them to
   * disagree at all.
   */
  const [ownLevels, setOwnLevels] = useState<PivotField[]>(() =>
    storageKey ? readStorage(storageKey, defaultLevels) : defaultLevels
  );
  const activeLevels  = lockHierarchy ? defaultLevels : ownLevels;
  const setActiveLevels = setOwnLevels;
  const [addOpen, setAddOpen] = useState(false);
  const [exp, setExp] = useState<Set<string>>(new Set());
  const [descSort, setDescSort] = useState<"asc" | "desc" | null>(null);
  const addRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!addOpen) return;
    function onDown(e: MouseEvent) {
      if (addRef.current && !addRef.current.contains(e.target as Node)) {
        setAddOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [addOpen]);

  // Persist hierarchy to localStorage whenever it changes
  useEffect(() => {
    if (!storageKey || lockHierarchy) return;
    try { localStorage.setItem(storageKey, JSON.stringify(activeLevels)); } catch { /* ignore */ }
  }, [storageKey, lockHierarchy, activeLevels]);

  /**
   * A different hierarchy is a different set of rows, so nothing that was open
   * in the old one means anything in the new one. Keyed on the levels rather
   * than the array so a re-render with an equal-but-new array does not collapse
   * the report under the reader.
   */
  const levelsKey = activeLevels.join("|");
  useEffect(() => { setExp(new Set()); }, [levelsKey]);

  function toggle(key: string) {
    setExp(prev => { const s = new Set(prev); s.has(key) ? s.delete(key) : s.add(key); return s; });
  }

  function moveLevel(idx: number, dir: -1 | 1) {
    const swap = idx + dir;
    setActiveLevels(prev => {
      if (swap < 0 || swap >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[swap]] = [next[swap], next[idx]];
      return next;
    });
    setExp(new Set());
  }

  function removeLevel(idx: number) {
    setActiveLevels(prev => prev.filter((_, i) => i !== idx));
    setExp(new Set());
  }

  function addLevel(f: PivotField) {
    setActiveLevels(prev => [...prev, f]);
    setAddOpen(false);
    setExp(new Set());
  }

  function resetLevels() {
    setActiveLevels(defaultLevels);
    setExp(new Set());
  }

  const isDefault = useMemo(
    () => activeLevels.length === defaultLevels.length && activeLevels.every((f, i) => f === defaultLevels[i]),
    [activeLevels, defaultLevels],
  );

  const months = useMemo(() => {
    const s = new Set(txs.map(t => t.month).filter(Boolean) as string[]);
    return MONTH_ORDER.filter(m => s.has(m));
  }, [txs]);

  const grandTotal = useMemo(() => txs.reduce((s, t) => s + (t.movement ?? 0), 0), [txs]);
  const grandByMonth = useMemo(() => {
    const m: Record<string, number> = {};
    for (const tx of txs) {
      const month = tx.month ?? "Unknown";
      m[month] = (m[month] ?? 0) + (tx.movement ?? 0);
    }
    return m;
  }, [txs]);

  const hasNonOp = useMemo(() => txs.some(t => (t.operational_pct ?? 100) < 100), [txs]);

  const workingTxs = useMemo(() => {
    // Fan out splits when Cost Center is in the hierarchy so each virtual row
    // carries its prorated movement and its own cost_center_id (same as CC Report).
    // Only applied when a splitsMap is provided — callers that pre-fan their data
    // (P&L All CC mode, Cost Center Report) omit splitsMap to avoid double-fanning.
    // Fanned when Cost Centre is a level OR when a cost-centre filter is on:
    // a transaction split 60/40 has to contribute its prorated share to the
    // selected centre, not all of itself or none.
    const needsFan = splitsMap && (activeLevels.includes("cost_center") || !!costCenterFilter);
    const fanned: PLReportTx[] = needsFan ? fanOutBySplits(txs, splitsMap!) : txs;

    // Filtered AFTER the fan-out, so each virtual row is judged by the centre
    // it was allocated to rather than by the transaction it came from.
    const kept = costCenterFilter
      ? fanned.filter((tx) => costCenterFilter.includes(stableScopeValue(tx as ExpandedTx, "cost_center")))
      : fanned;

    return activeLevels.includes("op_nonop") ? expandForOpNonOp(kept) : kept as ExpandedTx[];
  }, [txs, activeLevels, splitsMap, costCenterFilter]);

  // Scope shared by every cell of the report. The grand total row sits at this
  // level, so wrapping the tree in a synthetic root makes the note walk below
  // cover it with the same code path as any other row.
  const baseScope = useMemo<NoteScope>(
    () => (scopeYear != null ? { year: scopeYear } : {}),
    [scopeYear],
  );

  // Seed the tree with baseScope so every node carries the period. Building it
  // from an empty scope and prepending baseScope only at render time made the
  // note index key a node one way and the renderer another, so no indicator
  // ever matched below the grand total.
  const tree = useMemo(
    () => buildDynamicPivot(workingTxs, activeLevels, baseScope as Record<string, string>),
    [workingTxs, activeLevels, baseScope],
  );

  /**
   * Transaction-level notes are re-anchored against the live transactions
   * rather than trusting the scope stored in the database: under the superset
   * rule a note carrying only {transaction_id} would never roll up into an
   * aggregate cell, and deriving it here also keeps notes correct after the GL
   * mapping is edited and their transaction is re-categorized.
   */
  const resolved = useMemo(
    () => (enableNotes && notes?.length
      ? resolveNotes(notes, workingTxs, activeLevels, scopeYear)
      : { placed: [], orphaned: [] }),
    [enableNotes, notes, workingTxs, activeLevels, scopeYear],
  );
  const resolvedNotes = resolved.placed;

  // Surfaced to the page so it can render the orphan panel — the component
  // owns the resolution, but the panel lives outside the table.
  useEffect(() => { onOrphansChange?.(resolved.orphaned); }, [resolved.orphaned, onOrphansChange]);
  useEffect(() => { onResolvedNotes?.(resolved.placed); }, [resolved.placed, onResolvedNotes]);

  const noteIndex = useMemo(
    () => (enableNotes
      ? buildNoteIndex(resolvedNotes, [{ scope: baseScope, children: tree }])
      : { any: new Set<string>(), direct: new Set<string>() }),
    [enableNotes, resolvedNotes, tree, baseScope],
  );

  /**
   * Notes on one cell, resolved when asked rather than for every figure drawn.
   *
   * The hover preview is the only caller, and it fires for the handful of cells
   * a reader actually stops on — precomputing it would be a pass over the whole
   * note set per rendered figure, thousands of times per report.
   */
  const notesAt = useMemo(() => {
    return (scope: NoteScope): PLNote[] => {
      const { direct, rolledUp } = notesForCell(resolvedNotes, scope);
      return [...direct, ...rolledUp];
    };
  }, [resolvedNotes]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-blue-300 border-t-blue-600" />
      </div>
    );
  }

  if (txs.length === 0) {
    return <p className="py-10 text-center text-sm text-gray-400">{emptyMessage}</p>;
  }

  const available   = availableFields.filter(f => !activeLevels.includes(f));
  const levelHeader = activeLevels.length > 0
    ? activeLevels.map(f => FIELD_LABELS[f]).join(" → ")
    : "All Transactions";

  // Total Income banner.
  //
  // A solid colour, not bg-slate-100/90: the three cells of this row are sticky
  // (first column, months, Total) and a translucent background lets the rows
  // scrolling underneath show through the pinned edges. #f1f5f9 is slate-100 —
  // the same tone the class resolves to over white, without the transparency.
  const gtStyle: React.CSSProperties = {
    position: "sticky", top: 30, zIndex: 14,
    backgroundColor: homesiTheme ? "#f1f5f9" : TOTAL_BG,
    borderBottom: homesiTheme ? "2px solid #cbd5e1" : undefined,
  };

  const rows: React.ReactNode[] = [];

  // The Total column spans every displayed month, so its denominator is the sum
  // of those months' bases — not any single month's.
  const bpsBaseTotal = bpsBaseByMonth
    ? months.reduce((s, m) => s + (bpsBaseByMonth[m] ?? 0), 0)
    : 0;

  /**
   * The report's own total, as a cell.
   *
   * It has no hierarchy above it, so its only anchor is grand_total — supplied
   * explicitly here rather than derived, because there is no node to derive it
   * from. Its Total column is the one figure with no bounded movement list:
   * everything loaded is behind it.
   */
  const grandRef = (month: string | null, amount: number): CellRef =>
    buildCellRef({
      scope: baseScope, trail: ["Total Income"], month, amount,
      level: "grand_total", levelLabel: "Grand Total", valueLabel: "Total Income",
      // Its next level is the top of the hierarchy — the same rows the report
      // opens with, so even the report total costs one level and no more.
      children: tree,
      byMonth: grandByMonth,
    });

  // Total Income sticky row (always visible, based on raw txs)
  rows.push(
    <tr key="__grand__">
      <td
        style={{ ...gtStyle, ...firstColStyle, top: 30, zIndex: 22, paddingLeft: 12, backgroundColor: gtStyle.backgroundColor }}
        className={`overflow-hidden text-ellipsis whitespace-nowrap py-1.5 pr-3 text-xs font-bold ${
          homesiTheme ? "border-r-2 border-slate-300 text-[#001A40]" : "text-white"
        }`}
      >
        Total Income
      </td>
      {months.map(m => {
        const key = cellKey(baseScope, m);
        return (
          <td
            key={m}
            style={gtStyle}
            onClick={onDrillCell ? () => onDrillCell(grandRef(m, grandByMonth[m] ?? 0)) : undefined}
            className={`${numCell} ${homesiTheme ? `${colRule} font-bold text-[#001A40]` : `font-extrabold text-[12px] ${mvClsLight(grandByMonth[m])}`} ${onDrillCell ? "cursor-pointer" : ""}`}
          >
            {enableNotes ? (
              <NoteCellContent
                text={fmtM(grandByMonth[m])}
                hasNote={noteIndex.any.has(key)}
                isDirect={noteIndex.direct.has(key)}
                onOpenNotes={() => onOpenNotes?.(grandRef(m, grandByMonth[m] ?? 0))}
                previewNotes={() => notesAt({ ...baseScope, month: m })}
                badgeClass={homesiTheme ? grandTotalBadge(grandByMonth[m]) : ""}
                bps={bpsBaseByMonth ? fmtBps(grandByMonth[m], bpsBaseByMonth[m]) ?? "—" : null}
              />
            ) : (
              <span className={homesiTheme ? grandTotalBadge(grandByMonth[m]) : ""}>
                {fmtM(grandByMonth[m])}
              </span>
            )}
          </td>
        );
      })}
      <td
        style={{ ...gtStyle, ...totalColStyle, ...totalColSize, top: 30, zIndex: 21, borderLeft: homesiTheme ? "1px solid #cbd5e1" : "1px solid rgba(255,255,255,0.15)" }}
        // Bounded by nothing — every loaded row is behind this figure — so it
        // opens the window without a movement list rather than asking the
        // server for the whole table.
        onClick={onDrillCell ? () => onDrillCell(grandRef(null, grandTotal)) : undefined}
        className={`${numCell} ${homesiTheme ? "font-bold text-[#001A40]" : `font-extrabold text-[12px] ${mvClsLight(grandTotal)}`} ${onDrillCell ? "cursor-pointer" : ""}`}
      >
        {enableNotes ? (
          <NoteCellContent
            text={fmtM(grandTotal)}
            hasNote={noteIndex.any.has(cellKey(baseScope, null))}
            isDirect={noteIndex.direct.has(cellKey(baseScope, null))}
            onOpenNotes={() => onOpenNotes?.(grandRef(null, grandTotal))}
            previewNotes={() => notesAt(baseScope)}
            badgeClass={homesiTheme ? grandTotalBadge(grandTotal) : ""}
            bps={bpsBaseByMonth ? fmtBps(grandTotal, bpsBaseTotal) ?? "—" : null}
          />
        ) : (
          <span className={homesiTheme ? grandTotalBadge(grandTotal) : ""}>
            {fmtM(grandTotal)}
          </span>
        )}
      </td>
    </tr>
  );


  renderPivotNodes(tree, 0, rows, "root", [], {
    months,
    exp,
    toggle,
    descSort,
    notesOn: enableNotes,
    noteAny: noteIndex.any,
    noteDirect: noteIndex.direct,
    openNotes: (ref) => onOpenNotes?.(ref),
    notesAt,
    baseScope,
    homesi: homesiTheme,
    bpsBase: bpsBaseByMonth ?? null,
    bpsBaseTotal,
    onDrillCell: onDrillCell ?? null,
  });

  return (
    <div className="flex flex-col gap-2">
      {/* Hierarchy selector — omitted entirely when the hierarchy is fixed, so
          there is no affordance suggesting the levels can be rearranged. */}
      {!lockHierarchy && (
      <div className={`flex flex-wrap items-center gap-2 ${homesiTheme ? "rounded-2xl border border-slate-200 bg-slate-50 p-3" : "gap-1.5 rounded-xl border border-gray-100 bg-gray-50/60 px-3 py-2"}`}>
        <span className={`mr-0.5 shrink-0 uppercase ${homesiTheme ? "text-xs font-bold tracking-wider text-[#001A40]" : "text-[10px] font-semibold tracking-wide text-gray-400"}`}>
          {homesiTheme ? "Pivot hierarchy:" : "Pivot by:"}
        </span>

        {activeLevels.map((field, idx) => (
          <Fragment key={field}>
            {idx > 0 && <span className="select-none text-xs text-slate-300">→</span>}
            <div className={
              homesiTheme
                ? "inline-flex items-center gap-1.5 rounded-full border border-slate-200/90 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-xs hover:border-[#001A40]"
                : "inline-flex items-center rounded border border-gray-200 bg-white text-[11px] shadow-sm"
            }>
              <button
                onClick={() => moveLevel(idx, -1)}
                disabled={idx === 0}
                title="Move left"
                className={`px-1.5 py-0.5 disabled:cursor-default disabled:opacity-20 ${homesiTheme ? "text-slate-400 hover:text-[#001A40]" : "text-gray-400 hover:text-gray-600"}`}
              >↑</button>
              <button
                onClick={() => moveLevel(idx, 1)}
                disabled={idx === activeLevels.length - 1}
                title="Move right"
                className={`px-1.5 py-0.5 disabled:cursor-default disabled:opacity-20 ${homesiTheme ? "text-slate-400 hover:text-[#001A40]" : "text-gray-400 hover:text-gray-600"}`}
              >↓</button>
              <span className={homesiTheme ? "px-0.5" : "border-x border-gray-100 px-2 py-0.5 font-medium text-gray-700"}>
                {FIELD_LABELS[field]}
              </span>
              <button
                onClick={() => removeLevel(idx)}
                title="Remove level"
                className={`px-1.5 py-0.5 ${homesiTheme ? "text-slate-300 hover:text-[#FF4040]" : "text-gray-300 hover:text-red-400"}`}
              >×</button>
            </div>
          </Fragment>
        ))}

        {/* Add level dropdown */}
        <div className="relative" ref={addRef}>
          <button
            onClick={() => setAddOpen(o => !o)}
            disabled={available.length === 0}
            className="rounded border border-dashed border-gray-300 px-2 py-0.5 text-[11px] text-gray-400 hover:border-blue-400 hover:text-blue-600 disabled:cursor-default disabled:opacity-30"
          >
            + Add level
          </button>
          {addOpen && (
            <div className="absolute left-0 top-full z-50 mt-1 min-w-[190px] rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
              {available.map(f => (
                <button
                  key={f}
                  onClick={() => addLevel(f)}
                  className="w-full px-3 py-1.5 text-left text-[11px] text-gray-700 hover:bg-gray-50"
                >
                  {FIELD_LABELS[f]}
                </button>
              ))}
            </div>
          )}
        </div>

        {!isDefault && (
          <button
            onClick={resetLevels}
            className="ml-1 text-[11px] text-blue-500 underline hover:text-blue-700"
          >
            Reset
          </button>
        )}
      </div>
      )}

      {/* Active bps base, stated once directly above the grid instead of
          repeated inside every month header, where it collided with the short
          month names and pushed the header out of shape. Sits inside the same
          block as the table so it still travels with a screenshot of the
          report — which is the point: 100 bps over banked volume and 100 bps
          over total volume are different numbers that look identical. */}
      {bpsBaseLabel && (
        <div className="inline-flex items-center gap-1.5 self-start rounded-full border border-slate-200 bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-500">
          bps base
          <span className="text-[#001A40]">{bpsBaseLabel}</span>
        </div>
      )}

      {/* Hierarchy, as a breadcrumb above the grid. It used to fill the
          top-left header cell, where five levels of label stretched the column
          to several hundred pixels and pushed the months off the screen. Here
          it can scroll on its own without dragging the table with it. */}
      {activeLevels.length > 0 && (
        <div className="mb-3 flex items-center gap-1.5 overflow-x-auto whitespace-nowrap rounded-lg border border-slate-200/80 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-500">
          {activeLevels.map((f, i) => (
            <Fragment key={f}>
              {i > 0 && <span className="text-slate-300">→</span>}
              <span className={i === activeLevels.length - 1 ? "text-[#001A40]" : ""}>
                {FIELD_LABELS[f]}
              </span>
            </Fragment>
          ))}
        </div>
      )}

      {/* Pivot table */}
      <div
        className={`max-w-[1380px] overflow-auto border shadow-xs ${homesiTheme ? "rounded-2xl border-slate-200 bg-white" : "rounded-xl border-gray-200 bg-white shadow-sm"}`}
        style={{ maxHeight: "calc(100vh - 240px)" }}
      >
        <table className="w-full border-collapse">
          <thead className={`sticky top-0 z-20 ${homesiTheme ? "bg-slate-100/90" : "bg-gray-50"}`}>
            <tr className={`${homesiTheme ? "border-b-2 border-slate-200" : "border-b border-gray-200"}`}>
              <th
                title={levelHeader}
                style={{ ...firstColStyle, zIndex: 30 }}
                className={`text-left ${homesiTheme ? `${TH_LIGHT} border-r-2 border-slate-200` : "bg-gray-50 px-3 py-1.5 text-[10px] font-semibold text-gray-500"}`}
              >
                <span className="inline-flex items-center gap-1.5">
                  {/* Short, fixed title. The hierarchy runs to five levels and
                      several hundred characters; putting it here stretched the
                      cell and pushed the month columns off screen. It now sits
                      in a breadcrumb above the table. */}
                  Category / Account
                  <button
                    onClick={() => setDescSort(d => d === null ? "asc" : d === "asc" ? "desc" : null)}
                    title={descSort === null ? "Sort descriptions A→Z" : descSort === "asc" ? "Sort descriptions Z→A" : "Clear description sort"}
                    className="rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-[#001A40]"
                  >
                    {descSort === "asc"  ? <ArrowUpAZ   size={11} className="text-[#001A40]" /> :
                     descSort === "desc" ? <ArrowDownAZ size={11} className="text-[#001A40]" /> :
                                           <ChevronsUpDown size={11} />}
                  </button>
                </span>
              </th>
              {months.map(m => (
                <th key={m} className={`text-right whitespace-nowrap ${homesiTheme ? `${TH_LIGHT} ${colRule}` : "bg-gray-50 px-2 py-1.5 text-[10px] font-semibold text-gray-500"}`}>
                  {m.slice(0, 3)}
                </th>
              ))}
              <th
                style={{ ...totalColStyle, ...totalColSize, zIndex: 25 }}
                className={`border-l text-right whitespace-nowrap ${homesiTheme ? `border-slate-200 ${TH_LIGHT}` : "border-gray-200 bg-gray-50 px-2 py-1.5 text-[10px] font-semibold text-gray-500"}`}
              >
                Total
              </th>
            </tr>
          </thead>
          <tbody>{rows}</tbody>
        </table>
      </div>

    </div>
  );
}
