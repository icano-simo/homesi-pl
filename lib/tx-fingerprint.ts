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
  year?: number | null;
  month?: string | null;
}

/** Columns to request from Supabase when a note fingerprint is needed. */
export const FINGERPRINT_SELECT =
  "gl_code,ref_numb,journal_post_date,debit,credit,check_description";

/** Columns to request when an assignment fingerprint is needed. */
export const ASSIGNMENT_FINGERPRINT_SELECT =
  "gl_code,branch,check_description,journal_post_date,year,month,debit,credit";

/**
 * Field separator.
 *
 * Notes use "|" and must keep it: their fingerprints are already stored in
 * pl_notes.tx_fingerprint, and changing the separator would orphan every one.
 *
 * Assignment fingerprints are computed fresh on every replace and never
 * persisted, so they use a control character instead — which matters, because
 * "|" occurs inside the data. Measured on production: 2,568 of 12,316
 * transactions carry a "|" in a key field, e.g.
 * "747002005953|RALDA | JOSE ANTONIO". A separator that appears in the content
 * lets two different field splits produce the same key.
 */
const NOTE_SEP = "|";
const ASSIGNMENT_SEP = String.fromCharCode(1);

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
  // year is an integer column; month is TEXT ("March"), not a number.
  year:              (t: FingerprintableTx) =>
                       t.year === null || t.year === undefined ? "" : String(t.year),
  month:             (t: FingerprintableTx) => text(t.month ?? null),
} as const;

type FieldName = keyof typeof EXTRACTORS;

const buildKey = (fields: readonly FieldName[], tx: FingerprintableTx, sep: string) =>
  fields.map((f) => EXTRACTORS[f](tx)).join(sep);

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
 * Eight. An earlier version of this list used five — the four below plus
 * ref_numb — chosen from a measurement that covered only the 571 P&L
 * assignments. Re-measured over all 804 manual and conflict_resolved
 * assignments (2026-08-12), including the Offshore Allocations and employee_fee
 * rows the first pass missed:
 *
 *   4 fields                     576 unique   228 ambiguous   worst group 732
 *   5 fields (+ ref_numb)        580 unique   224 ambiguous   worst group 732
 *   8 fields (below)             799 unique     5 ambiguous   worst group   4
 *
 * ref_numb is deliberately NOT here. It is empty in all 233 assignments whose
 * journal_post_date is null — the ones that actually need disambiguating — and
 * populated only on source='original' rows (570 of 804). Adding it as a ninth
 * field measures identically to eight: 799 unique, 5 ambiguous. Since the key
 * is conjunctive, a field that splits no group can only add risk: an assignment
 * that matches today would become not_found if ref_numb changed between
 * exports. Zero measured gain, non-zero risk.
 *
 * The concern behind the old five-field key — that "Replace existing" is what
 * you run when a *corrected* file arrives, so amounts are the field most likely
 * to have moved — is real, but it is answered by the reapply refusing to guess
 * rather than by a looser key. An assignment that no longer matches is recorded
 * as not_found, and an ambiguous one keeps its candidate ids for a human. The
 * cautious key was buying safety the caller now provides directly, at the cost
 * of 223 assignments that could not be restored at all.
 */
const ASSIGNMENT_FIELDS: readonly FieldName[] = [
  "gl_code", "branch", "check_description", "journal_post_date",
  "year", "month", "debit", "credit",
];

/**
 * Content hash used to reattach a note to its transaction after a re-upload.
 * Every field is raw off the GL Detail Report — none derived or enriched — so
 * re-parsing the same file yields the same fingerprint. The date is used as
 * stored (an ISO yyyy-mm-dd string from normalizePL) rather than re-parsed, so
 * time zones cannot shift it.
 */
export function txFingerprint(tx: FingerprintableTx): string {
  return buildKey(NOTE_FIELDS, tx, NOTE_SEP);
}

/** Content hash used to reapply a manual cost-center assignment after a replace. */
export function assignmentFingerprint(tx: FingerprintableTx): string {
  return buildKey(ASSIGNMENT_FIELDS, tx, ASSIGNMENT_SEP);
}

/**
 * Groups transactions by fingerprint. A fingerprint mapping to more than one
 * id is genuinely ambiguous — identical lines on the same day are normal in a
 * GL detail — and callers must refuse to guess between them.
 *
 * Defaults to the note fingerprint, which is what the orphan-note sweep wants.
 * Pass assignmentFingerprint to group by the assignment key instead; the two
 * must never be mixed in one map.
 */
export function groupByFingerprint<T extends FingerprintableTx & { id: string }>(
  txs: readonly T[],
  fingerprint: (tx: FingerprintableTx) => string = txFingerprint,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const tx of txs) {
    const fp = fingerprint(tx);
    const arr = map.get(fp);
    if (arr) arr.push(tx.id);
    else map.set(fp, [tx.id]);
  }
  return map;
}
