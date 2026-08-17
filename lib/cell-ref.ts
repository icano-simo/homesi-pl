import type { NoteLevel, NoteScope } from "@/lib/note-scope";

/** A level a note can be anchored to, named. */
export interface AnchorOption {
  level: NoteLevel;
  /** "Category 6", "GL Code — GL Name", "Description"… */
  levelLabel: string;
  /** The value at that level, as the report prints it. */
  valueLabel: string;
  /** Full conjunction down to this level, period included. */
  scope: NoteScope;
  /** That cell's figure for the same period — stored on the note when written. */
  amount: number;
}

/** One row of the next level down. Also, one of the anchors on offer. */
export interface BreakdownRow extends AnchorOption {
  /** Movements behind it. */
  count?: number;
  /** Stable group key, so a row and its month cells can be matched up. */
  key?: string;
  /** The month this row is about, in the per-month breakdown. */
  month?: string;
  /** Figure per month, for the trend matrix. Only on Total-column cells. */
  byMonth?: Record<string, number>;
}

/**
 * A cell of the report, as the pivot hands it over.
 *
 * Carries the breakdown one level down and nothing deeper. That single decision
 * is what makes every level behave the same: a cost centre, a category, a GL
 * and a description all open the same window, and none of them loads more than
 * the handful of rows directly beneath it. The old shape — a cell plus every
 * movement under it — made clicking a cost centre a different and far more
 * expensive act than clicking a GL.
 *
 * Carries no report filters: the page owns those and adds them when it turns
 * this into a request. The pivot knows the shape of the cell, the page knows
 * what was loaded.
 */
export interface CellRef {
  /** Dimension constraints of the cell, month included when it is a month cell. */
  scope: NoteScope;
  /** Readable trail, e.g. ["Personnel", "Salaries", "61100 — Base Pay"]. */
  breadcrumb: string[];
  /** Heading of the window — the deepest label of the trail. */
  title: string;
  /** Null on the Total column, whose cell spans every month shown. */
  month: string | null;
  /**
   * Months this cell actually has rows in, in calendar order — the columns of
   * the trend matrix. Only the months present, which is the first and cheapest
   * of the four things keeping that table narrow: measured on 2026, 4 GL cells
   * span one month and 35 span six.
   */
  months: string[];
  /** The figure as it stands right now. */
  amount: number;
  /**
   * The same figure split by month, straight from the report.
   *
   * The heading of the window reads from here when the month filter is on, so
   * it shows the number the P&L shows in that month's column — not a sum of
   * whatever rows happen to be listed below, which would be a second
   * computation able to disagree with the first.
   */
  byMonth: Record<string, number>;
  /** The cell itself, as an anchor. */
  self: AnchorOption;
  /**
   * The level below, resolved from the tree — so its figures are the report's
   * own figures rather than a second computation that could disagree.
   *
   * Null at the deepest level of the hierarchy, where what comes next is a
   * description rather than a level of the pivot. `descriptions` covers that
   * case, and it too comes from the tree.
   */
  children: BreakdownRow[] | null;
  /** Header for the breakdown column. Null when `children` is. */
  childLevelLabel: string | null;
  /**
   * The three description breakdowns of the deepest cell, from its own rows.
   *
   * Measured, and the reason this is not a query: under a cost centre the rows
   * behind a GL cell are the report's rows — prorated by the allocation split
   * and expanded for op/non-op — while a query by cost_center_id returns the
   * raw assignment. On CC01 in June, 7 of 18 GL cells disagreed, the worst by
   * 10.161,63 against a figure of 18.993,66. A window whose heading and whose
   * breakdown are two different numbers is worse than no window.
   *
   * All three are computed because no single description serves every account,
   * and only the counts can say which one this cell actually carries.
   */
  descriptions: DescriptionBreakdown[] | null;
}

export interface DescriptionBreakdown {
  /** Note level this dimension anchors to: description / check_desc_2 / _3. */
  level: NoteLevel;
  label: string;
  /** Rows in this cell that carry it. Zero means picking it shows nothing. */
  populated: number;
  /** The same count per month, so the pills follow the month filter. */
  populatedByMonth: Record<string, number>;
  /** One row per description. The whole breakdown in a month cell; the rows of
   *  the matrix, and the "all months" anchors, on the Total column. */
  rows: BreakdownRow[];
  /** One row per description and month. Total column only. */
  perMonth: BreakdownRow[] | null;
  /**
   * How much shorter the matrix is than the list: perMonth rows ÷ description
   * rows, both ignoring the "no description" bucket — the absence of a
   * description is not a description.
   *
   * This is what the trend view is for, measured directly. The rule it replaced
   * — "most descriptions repeat" — was a proxy for it and disagreed with the
   * data: Telephone & VOIP repeats in 162 of 328 descriptions, not a majority,
   * yet its list is 921 rows against 328 and the matrix is plainly the better
   * read.
   *
   * Total column only; null on a month cell, which has one column and no choice
   * to make.
   */
  compression: number | null;
  suggestedMode: BreakdownMode | null;
}

export type BreakdownMode = "trend" | "byMonth";

/**
 * Above this, the matrix is offered first.
 *
 * A line drawn across a continuum, not a boundary found in the data. On the 177
 * cell × description combinations of the two hierarchies the values either side
 * of it are 1,500 and 1,455 — neighbours. It reproduces the eight accounts that
 * were measured by hand, and that is all it claims.
 *
 * Which is exactly why the switch is visible and never automatic: near the line
 * the right answer is genuinely arguable, and the reader settles it in one
 * click. Do not read 1.5 as a threshold with a meaning of its own.
 */
export const TREND_COMPRESSION_MIN = 1.5;
