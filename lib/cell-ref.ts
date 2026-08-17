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
  /** Rows behind it, when the breakdown came from the server. */
  count?: number;
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
  /** The figure as it stands right now. */
  amount: number;
  /** The cell itself, as an anchor. */
  self: AnchorOption;
  /**
   * The level below, already resolved from the tree — so its figures are the
   * report's own figures rather than a second computation that could disagree.
   *
   * Null at the deepest level of the hierarchy, where what comes next is a
   * description rather than a level of the pivot, and only the server can say
   * which of the three descriptions the rows actually carry.
   */
  children: BreakdownRow[] | null;
  /** Header for the breakdown column. Null when `children` is. */
  childLevelLabel: string | null;
}
