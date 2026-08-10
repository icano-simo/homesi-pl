/**
 * Canonical content hash of a transaction — what makes two rows "the same
 * transaction" across a re-upload.
 *
 * pl_transactions rows are hard-deleted and re-inserted when a month is
 * replaced (see deleteUpload in lib/check-duplicate-upload.ts), so their UUIDs
 * are not stable. Anything that needs to survive that — a note anchored to one
 * transaction, a manual cost center assignment — has to re-find its row by
 * content instead.
 *
 * SINGLE SOURCE OF TRUTH: every caller must import from here. A second copy of
 * this calculation drifting from this one would silently fail to match and the
 * failure would look like "the data changed", not like a bug.
 */

/** The subset of a transaction any fingerprint is computed from. */
export interface FingerprintableTx {
  gl_code: string | null;
  branch?: string | null;
  ref_numb: string | null;
  journal_post_date: string | null;
  debit: number | string | null;
  credit: number | string | null;
  check_description: string | null;
}

/** Columns to request from Supabase when a note fingerprint is needed. */
export const FINGERPRINT_SELECT =
  "gl_code,ref_numb,journal_post_date,debit,credit,check_description";

/** Columns to request when an assignment fingerprint is needed. */
export const ASSIGNMENT_FINGERPRINT_SELECT =
  "gl_code,branch,check_description,journal_post_date,ref_numb";

/**
 * Money columns are numeric(14,2). Depending on the driver they come back as
 * a number (1234.5) or a string ("1234.50"), and the two would hash
 * differently. Fixing the scale makes the hash independent of that.
 */
function money(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === "") return "0.00";
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : "0.00";
}

function text(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase();
}

/**
 * One extractor per field — the only place each field's normalization is
 * defined. Every key below is composed from this table, so two fingerprints can
 * differ in which fields they use but never in how a shared field is rendered.
 */
const EXTRACTORS = {
  gl_code:           (t: FingerprintableTx) => text(t.gl_code),
  branch:            (t: FingerprintableTx) => text(t.branch ?? null),
  ref_numb:          (t: FingerprintableTx) => text(t.ref_numb),
  journal_post_date: (t: FingerprintableTx) => t.journal_post_date ?? "",
  debit:             (t: FingerprintableTx) => money(t.debit),
  credit:            (t: FingerprintableTx) => money(t.credit),
  check_description: (t: FingerprintableTx) => text(t.check_description),
} as const;

type FieldName = keyof typeof EXTRACTORS;

const buildKey = (fields: readonly FieldName[], tx: FingerprintableTx) =>
  fields.map((f) => EXTRACTORS[f](tx)).join("|");

/**
 * Fields, and their order, behind a note's tx_fingerprint.
 *
 * The order is load-bearing: fingerprints already stored on notes were produced
 * by this exact sequence, and reordering would silently stop them matching.
 */
const NOTE_FIELDS: readonly FieldName[] = [
  "gl_code", "ref_numb", "journal_post_date", "debit", "credit", "check_description",
];

/**
 * Fields behind manual cost-center assignment matching.
 *
 * Five, not the note set's six-plus-amounts, and the difference is deliberate.
 * Measured over the live data (2026-08-07): the four-field key this replaced
 * left 4 of 571 P&L assignments ambiguous, and adding ref_numb alone takes that
 * to 0. Adding debit/credit as well buys nothing more for P&L — it only helps
 * Offshore Allocations rows that lack a date and description — while making
 * every one of the 567 assignments that restore correctly today newly dependent
 * on the amount being unchanged.
 *
 * That matters because "Replace existing" is what you run when a *corrected*
 * file arrives, so the amounts are exactly the field most likely to have moved.
 * A note that fails to match lands in the Orphaned Notes panel and can be
 * placed by hand; a manual assignment that fails to match silently reverts to
 * whatever the rules decided. The asymmetry is why this key is the cautious one.
 */
const ASSIGNMENT_FIELDS: readonly FieldName[] = [
  "gl_code", "branch", "check_description", "journal_post_date", "ref_numb",
];

/**
 * Content hash used to reattach a note to its transaction after a re-upload.
 * Every field is raw off the GL Detail Report — none derived or enriched — so
 * re-parsing the same file yields the same fingerprint. The date is used as
 * stored (an ISO yyyy-mm-dd string from normalizePL) rather than re-parsed, so
 * time zones cannot shift it.
 */
export function txFingerprint(tx: FingerprintableTx): string {
  return buildKey(NOTE_FIELDS, tx);
}

/** Content hash used to reapply a manual cost-center assignment after a replace. */
export function assignmentFingerprint(tx: FingerprintableTx): string {
  return buildKey(ASSIGNMENT_FIELDS, tx);
}

/**
 * Groups transactions by fingerprint. A fingerprint mapping to more than one
 * id is genuinely ambiguous — identical lines on the same day are normal in a
 * GL detail — and callers must refuse to guess between them.
 */
export function groupByFingerprint<T extends FingerprintableTx & { id: string }>(
  txs: readonly T[],
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const tx of txs) {
    const fp = txFingerprint(tx);
    const arr = map.get(fp);
    if (arr) arr.push(tx.id);
    else map.set(fp, [tx.id]);
  }
  return map;
}
