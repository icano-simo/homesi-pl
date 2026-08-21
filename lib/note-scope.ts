import { ALL_FIELDS, stableScopeValue, type ExpandedTx, type PivotField } from "@/lib/pivot-engine";
import type { PLReportTx } from "@/types";

/**
 * Note anchoring — see supabase/migrations/20260805_pl_notes.sql for the model.
 *
 * A cell of the pivot is defined by the conjunction of dimension constraints on
 * the path from the root, plus the period (month/year). A note stores exactly
 * that conjunction, so it survives any reordering of the "Pivot by:" hierarchy.
 *
 * Visibility rule: note N shows under cell C iff scope(N) ⊇ scope(C).
 * More constraints = more specific = fewer transactions, so notes roll up the
 * tree and never leak down into cells more granular than themselves.
 */

/**
 * Dimension keys usable in a scope: every pivot field, the period, and the
 * transaction id.
 *
 * `transaction_id` earns its place as a scope dimension rather than living only
 * in its own column: two transactions sharing a GL code in the same month have
 * identical dimension maps, so without it their notes would be indistinguishable
 * and both would read as "direct" notes on the group. Carrying it makes a
 * transaction note strictly more specific than the leaf group above it, which
 * is exactly what makes it roll up under the superset rule.
 */
export type ScopeKey =
  | PivotField
  | "month"
  | "year"
  /**
   * The branch the report was showing when the note was written.
   *
   * Not a pivot level — no hierarchy has it — but a constraint of the cell all
   * the same: the same GL in the same month is a different figure in 700 than
   * in 710, and until this existed a note written looking at one appeared on
   * the other. Confirmed on all 6 notes in the table: none carried it.
   *
   * The visibility rule needs no special case. A note with branch=700 shows
   * where the cell constrains branch to 700, and in the unfiltered view which
   * constrains nothing; a note with no branch shows only in that unfiltered
   * view, which is exactly what "no branch" should mean.
   */
  | "branch"
  | "transaction_id"
  // ── Per-entity log anchors ────────────────────────────────────────────────
  // Same table, different purpose: these identify an entity whose change
  // history is being recorded, not a cell of the pivot. They are intentionally
  // NOT pivot dimensions, which is what isPivotScope() below keys off to keep
  // log notes out of the report's roll-up.
  | "cost_center_id"
  | "assign_type"
  | "assign_value";

export type NoteScope = Partial<Record<ScopeKey, string | number>>;

export type NoteLevel = PivotField | "transaction" | "grand_total";

export interface PLNote {
  id: string;
  level: NoteLevel;
  scope: NoteScope;
  scope_key: string;
  transaction_id: string | null;
  tx_fingerprint: string | null;
  /** Set when the note lost its transaction; cleared when it is reattached. */
  orphaned_at: string | null;
  note_text: string;
  author: string | null;
  /** Figure of the cell when the note was written. Null for notes created
   *  before the column existed — those show only the current amount. */
  amount_at_creation?: number | null;
  created_at: string;
  updated_at: string;
}

/** Human labels for scope keys, used in the drawer breadcrumb. */
export const SCOPE_LABELS: Record<ScopeKey, string> = {
  op_nonop:     "Operational / Non-Op",
  category_2:   "Category 2",
  category_6:   "Category 6",
  category_7:   "Category 7",
  gl:           "GL Code",
  cost_center:  "Cost Center",
  description:  "Description",
  check_desc_2: "Description 2",
  check_desc_3: "Description 3",
  loan_number:  "Loan Number",
  month:          "Month",
  year:           "Year",
  branch:         "Branch",
  transaction_id: "Transaction",
  cost_center_id: "Cost Center",
  assign_type:    "Assignment Type",
  assign_value:   "Assigned To",
};

// ─── Canonical serialization ──────────────────────────────────────────────────

/**
 * Deterministic string form of a scope: keys sorted, values URI-encoded so that
 * free-text dimensions (descriptions can contain "|" or "=") cannot forge a
 * different scope. Two scopes are equal iff their canonical keys are equal.
 */
export function canonicalScopeKey(scope: NoteScope): string {
  return Object.keys(scope)
    .filter((k) => scope[k as ScopeKey] !== undefined && scope[k as ScopeKey] !== null)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(String(scope[k as ScopeKey]))}`)
    .join("|");
}

// ─── The visibility rule ──────────────────────────────────────────────────────

/**
 * True when `outer` carries every constraint of `inner` with the same value —
 * i.e. `outer` is at least as specific as `inner`.
 *
 * Values are compared as strings because a scope round-trips through JSONB,
 * where a year may come back as 2026 or "2026" depending on how it was written.
 */
export function scopeContains(outer: NoteScope, inner: NoteScope): boolean {
  for (const k of Object.keys(inner) as ScopeKey[]) {
    const want = inner[k];
    if (want === undefined || want === null) continue;
    const have = outer[k];
    if (have === undefined || have === null) return false;
    if (String(have) !== String(want)) return false;
  }
  return true;
}

/** A note belongs to exactly this cell (not merely rolled up from below). */
export function isDirectNote(note: PLNote, cellScope: NoteScope): boolean {
  return note.scope_key === canonicalScopeKey(cellScope);
}

// ─── Deriving a scope from a transaction ──────────────────────────────────────

/**
 * Stable scope value for one pivot dimension of a transaction.
 *
 * Deliberately re-exported from the pivot engine rather than reimplemented:
 * the engine is the authority on how transactions are grouped, and a second
 * copy of the sentinel values (__unassigned__, __no_loan__, "(No GL)") would
 * silently detach notes the moment the two drifted apart.
 */
export { stableScopeValue as scopeValueForField } from "@/lib/pivot-engine";

/**
 * Full dimension map of a single transaction — the maximally specific scope.
 *
 * Transaction-level notes are resolved through this at load time rather than
 * trusting the scope stored in the database. Two reasons: under the strict
 * superset rule a note scoped to just {transaction_id} would never satisfy the
 * containment test against an aggregate cell and would never roll up; and
 * deriving live means a note stays correct after the GL mapping is edited and
 * the transaction is re-categorized.
 */
export function scopeForTransaction(
  tx: ExpandedTx,
  fields: readonly PivotField[],
  year?: number,
): NoteScope {
  const scope: NoteScope = {};
  for (const f of fields) scope[f] = stableScopeValue(tx, f);
  if (tx.month) scope.month = tx.month;
  // The year always belongs in the scope. It used to be added only when the
  // report covered exactly one, so a two-year load produced scopes with no
  // year at all — which changes the key, and with it which notes count as
  // written-on-this-cell rather than inherited. Falling back to the
  // transaction’s own year keeps the anchor stable no matter how many years
  // happen to be loaded.
  const resolvedYear = year ?? tx.year ?? null;
  if (resolvedYear != null) scope.year = resolvedYear;
  // The transaction's own branch. Without it a transaction note re-anchored
  // here would come back branchless and stop matching the cells above it,
  // which now carry the branch of the report.
  if (tx.branch) scope.branch = tx.branch;
  scope.transaction_id = tx.id;
  return scope;
}

// ─── Resolving notes against the loaded data ──────────────────────────────────

/**
 * Replaces the stored scope of transaction-level notes with the live dimension
 * map of the transaction they point at, so they roll up correctly.
 *
 * Notes whose transaction is not in the current result set (filtered out, or
 * orphaned by a re-upload) are dropped — they cannot be placed on any cell of
 * this report. Aggregate notes pass through unchanged.
 */
/**
 * Keys a pivot cell can be anchored by. Anything else means the note belongs to
 * a per-entity log (a cost center's history, an employee's, a vendor's) rather
 * than to a cell of the report.
 */
const PIVOT_SCOPE_KEYS = new Set<string>([
  ...ALL_FIELDS, "month", "year", "branch", "transaction_id",
]);

/**
 * True when every dimension of the scope is one the pivot can render.
 *
 * Log notes live in the same table but are anchored by keys like
 * `cost_center_id` or `assign_value`, which no pivot node constrains. Without
 * this guard a log note would vacuously satisfy the containment test against
 * loosely-constrained cells — lighting up the grand total of a report it has
 * nothing to do with.
 */
export function isPivotScope(scope: NoteScope): boolean {
  const keys = Object.keys(scope);
  return keys.length > 0 && keys.every((k) => PIVOT_SCOPE_KEYS.has(k));
}

export interface ResolvedNotes {
  /** Notes that map onto a cell of the current report. */
  placed: PLNote[];
  /** Transaction-level notes whose transaction no longer exists. */
  orphaned: PLNote[];
}

export function resolveNotes(
  notes: readonly PLNote[],
  txs: readonly ExpandedTx[],
  fields: readonly PivotField[],
  year?: number,
): ResolvedNotes {
  // One transaction can appear several times in `txs`: expandForOpNonOp splits
  // it into an Operational and a Non-Operational row, and fanOutBySplits copies
  // it once per cost center. Each copy sits in a different branch of the tree,
  // so a note on that transaction has to be anchored to every one of them —
  // indexing by id alone would keep only the last copy and the note would show
  // under a single arbitrary branch.
  const byId = new Map<string, ExpandedTx[]>();
  for (const tx of txs) {
    const arr = byId.get(tx.id);
    if (arr) arr.push(tx);
    else byId.set(tx.id, [tx]);
  }

  const out: PLNote[] = [];
  const orphaned: PLNote[] = [];
  for (const note of notes) {
    // Per-entity log notes share this table but belong to no cell of the pivot.
    if (!isPivotScope(note.scope)) continue;
    if (note.level !== "transaction") { out.push(note); continue; }
    const copies = note.transaction_id ? byId.get(note.transaction_id) : undefined;
    if (!copies) {
      // A note whose transaction is gone has no cell to sit on. It used to be
      // dropped here, which made it invisible everywhere while still existing
      // in the database — the user's comment simply vanished after a re-upload.
      // It is now handed back separately so the UI can surface it.
      if (note.transaction_id === null) orphaned.push(note);
      continue;
    }
    // Distinct scopes only — a transaction with no split and no op/non-op
    // expansion yields a single copy, and duplicates would just be extra work.
    const seen = new Set<string>();
    for (const tx of copies) {
      const scope = scopeForTransaction(tx, fields, year);
      const key = canonicalScopeKey(scope);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...note, scope, scope_key: key });
    }
  }
  return { placed: out, orphaned };
}

/**
 * Marks every cell that must show a note indicator.
 *
 * Rather than testing each of the (nodes × months) cells against each note —
 * millions of map comparisons per render — this pushes each note *down* from
 * the root, descending only into the child whose constraint the note's scope
 * satisfies and pruning every other branch. A note therefore visits exactly the
 * cells that roll it up, and the whole pass costs O(notes × depth) — a few
 * thousand operations for hundreds of notes.
 *
 * Returns a set of "<canonical node scope>@<month>" keys; "@__total__" marks
 * the row's Total column. `direct` holds the cells a note was written on, so
 * the UI can distinguish an own note from one inherited from below.
 */
export function buildNoteIndex(
  notes: readonly PLNote[],
  roots: readonly { scope: NoteScope; children: readonly { scope: NoteScope; children: readonly unknown[] }[] }[],
): { any: Set<string>; direct: Set<string> } {
  const any = new Set<string>();
  const direct = new Set<string>();

  type Node = { scope: NoteScope; children: readonly Node[] };

  const month = (note: PLNote) => note.scope.month as string | undefined;

  /**
   * Marks the month cell (when the note has a period) and the Total column.
   *
   * "Direct" is decided per cell, not once for both. A note written on June is
   * direct on June and inherited on the Total column — the Total column is a
   * cell of its own, with no month in its scope, and a note can be written
   * straight onto it. Deciding once made a June note claim the Total column as
   * its own, so the two were indistinguishable there.
   */
  const mark = (base: NoteScope, note: PLNote) => {
    const key = canonicalScopeKey(base);
    const m = month(note);
    const cells: [string, NoteScope][] = [
      ...(m ? ([[`${key}@${m}`, { ...base, month: m }]] as [string, NoteScope][]) : []),
      [`${key}@__total__`, base],
    ];
    for (const [cell, cellScope] of cells) {
      any.add(cell);
      if (note.scope_key === canonicalScopeKey(cellScope)) direct.add(cell);
    }
  };

  const visit = (nodes: readonly Node[], note: PLNote) => {
    for (const node of nodes) {
      // scope(note) must contain every constraint of this node to roll up here.
      if (!scopeContains(note.scope, node.scope)) continue;

      mark(node.scope, note);

      // Transaction rows are leaves of the render, not nodes of the tree, so
      // walking children alone never reaches them and a note on a transaction
      // lit up its ancestors but not its own row. Its cell scope is the node's
      // plus the transaction id, which is enough to mark it without having to
      // enumerate the leaves themselves.
      const txId = note.scope.transaction_id;
      if (txId !== undefined && txId !== null) {
        mark({ ...node.scope, transaction_id: txId }, note);
      }

      visit(node.children, note);
    }
  };

  for (const note of notes) visit(roots as readonly Node[], note);
  return { any, direct };
}

/**
 * Cell key matching the one produced by buildNoteIndex.
 *
 * `nodeScope` must NOT carry `month`: the period lives in the suffix only.
 * Passing it in both places yields a key the index never produces, which is
 * exactly how the indicators went missing on every month column.
 */
export function cellKey(nodeScope: NoteScope, month: string | null): string {
  return `${canonicalScopeKey(nodeScope)}@${month ?? "__total__"}`;
}

/**
 * Every note visible on a cell, newest first, split into the ones written on
 * this exact cell and the ones rolled up from more granular levels.
 */
export function notesForCell(
  notes: readonly PLNote[],
  cellScope: NoteScope,
): { direct: PLNote[]; rolledUp: PLNote[] } {
  const key = canonicalScopeKey(cellScope);
  const direct = new Map<string, PLNote>();
  const rolledUp = new Map<string, PLNote>();

  for (const note of notes) {
    if (!scopeContains(note.scope, cellScope)) continue;
    // resolveNotes emits one entry per branch a transaction was fanned into, so
    // the same note can match a cell more than once. Key by id to list it once.
    if (note.scope_key === key) direct.set(note.id, note);
    else if (!direct.has(note.id)) rolledUp.set(note.id, note);
  }
  for (const id of direct.keys()) rolledUp.delete(id);

  const newestFirst = (a: PLNote, b: PLNote) => b.created_at.localeCompare(a.created_at);
  return {
    direct:   [...direct.values()].sort(newestFirst),
    rolledUp: [...rolledUp.values()].sort(newestFirst),
  };
}

// ─── Breadcrumbs ──────────────────────────────────────────────────────────────

/**
 * Readable trail for a scope, e.g. "Income › Revenue › April".
 * `labelFor` resolves stable ids back to display names (gl_code → "41309 —
 * Origination Income", cost_center_id → cost center name).
 */
export function scopeBreadcrumb(
  scope: NoteScope,
  order: readonly ScopeKey[],
  labelFor?: (key: ScopeKey, value: string) => string,
): string[] {
  const seen = new Set<string>();
  const parts: string[] = [];

  const push = (k: ScopeKey) => {
    const v = scope[k];
    if (v === undefined || v === null || seen.has(k)) return;
    seen.add(k);
    const label = labelFor ? labelFor(k, String(v)) : String(v);
    // A resolver returns "" for dimensions with no readable form (a raw
    // transaction UUID adds nothing to a trail) — drop them rather than
    // rendering an empty crumb.
    if (label) parts.push(label);
  };

  for (const k of order) push(k);
  for (const k of Object.keys(scope) as ScopeKey[]) push(k);
  return parts;
}


/**
 * Label for a scope key/value pair, used when no resolver is supplied.
 *
 * Lives here rather than in a drawer component: it is the counterpart of
 * scopeBreadcrumb, and every consumer of one wants the other.
 */
export function defaultScopeLabel(key: ScopeKey, value: string): string {
  if (value === "__unassigned__") return "Unassigned";
  if (value === "__conflict__")   return "Conflict";
  if (value === "__no_loan__")    return "No Loan Number";
  if (key === "year") return String(value);
  return value || SCOPE_LABELS[key];
}