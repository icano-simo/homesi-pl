import type { NoteLevel, NoteScope } from "@/lib/note-scope";

/**
 * One level a note can be anchored to, from the clicked cell up to the top of
 * the hierarchy.
 *
 * The whole chain is offered, not just the two ends. A note about a cost centre,
 * a Category 6 or a Category 7 has no other way of being written: the figure
 * that opens the window is always the deepest one the reader happened to click,
 * and if the picker only listed that level and the transaction below it, every
 * intermediate level would be unreachable.
 */
export interface AnchorOption {
  level: NoteLevel;
  /** "Category 6", "GL Code — GL Name"… */
  levelLabel: string;
  /** The value at that level, as the report prints it. */
  valueLabel: string;
  /** Full conjunction down to this level, period included. */
  scope: NoteScope;
  /** Figure of that level's cell for the same period — stored on the note. */
  amount: number;
}

/**
 * A cell of the report, as the pivot hands it over.
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
  /** Heading of the detail window — the deepest label of the trail. */
  title: string;
  month: string | null;
  /** The figure as it stands right now. */
  amount: number;
  /** Every level from the top of the hierarchy down to this cell. */
  anchors: AnchorOption[];
  /**
   * False for the whole-report Total, whose movement list is the entire table.
   * Everything else is bounded by a dimension or by a month.
   */
  drillable: boolean;
}
