// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

import type { ManualAssignmentSummary } from "@/types";

const BACKUP_TABLE = "manual_assignment_backups";
const CHUNK = 500;
const PAGE_SIZE = 1000;

/**
 * Fields that decide whether a backed-up assignment and a freshly inserted
 * expense are the same thing.
 *
 * Measured against production on 2026-08-12, over 756 manual and 48
 * conflict_resolved assignments: with only gl_code, branch, check_description
 * and journal_post_date, 228 matched more than one expense and the worst group
 * held 732 rows. Adding year, month, debit and credit makes all 196
 * employee_fee cases unique and 31 of the 36 offshore ones. About 5 stay
 * genuinely indistinguishable — several identical expenses on the same day for
 * the same amount — and those are meant to end up ambiguous rather than guessed.
 *
 * 233 of the manual assignments sit on expenses with a NULL journal_post_date
 * (and an empty ref_numb), all from employee_fee, offshore_allocations and
 * addback. That is why year and month carry real weight here: for those rows
 * they are the only period information there is.
 *
 * month is TEXT ("March"), not a number.
 */
const MATCH_FIELDS = [
  "gl_code", "branch", "check_description", "journal_post_date",
  "year", "month", "debit", "credit",
] as const;

const MATCH_SELECT = `id, ${MATCH_FIELDS.join(", ")}`;

type MatchKeyed = {
  gl_code: string | null;
  branch: string | null;
  check_description: string | null;
  journal_post_date: string | null;
  year: number | null;
  month: string | null;
  debit: number | string | null;
  credit: number | string | null;
};

/**
 * Canonical form of the match key.
 *
 * debit and credit are numeric(14,2) and come back as a number or a string
 * depending on the driver, so 1234.5 and "1234.50" must not be treated as
 * different expenses. Everything else is compared as-is; a NULL stays distinct
 * from an empty string, which matters because the 233 dateless rows carry a
 * real NULL.
 */
/**
 * Field separator for the match key. A control character, so it cannot occur in
 * a GL description and two fields can never run together into a colliding key.
 * Built from a char code rather than written literally: a raw control byte in
 * source is invisible in every editor and diff, and this repo has already lost
 * an afternoon to one.
 */
const SEP = String.fromCharCode(1);

export function money(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === "") return "~";
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : "~";
}

export function matchKey(t: MatchKeyed): string {
  return [
    t.gl_code ?? "~",
    t.branch ?? "~",
    t.check_description ?? "~",
    t.journal_post_date ?? "~",
    t.year === null || t.year === undefined ? "~" : String(t.year),
    t.month ?? "~",
    money(t.debit),
    money(t.credit),
  ].join(SEP);
}

interface BackupRow extends MatchKeyed {
  id: string;
  assignment_origin: "manual" | "conflict_resolved";
  cost_center_id: string;
  conflict_snapshot: {
    conflicting_cc_ids: string[];
    resolved_cc_id: string;
    resolved_at: string;
  } | null;
  splits: Array<{ cost_center_id: string; percentage: number; is_operational: boolean }>;
}

/**
 * Captures every manual and conflict_resolved assignment of an upload and
 * writes it to finance_division.manual_assignment_backups.
 *
 * MUST be called, and MUST have returned, before deleteUpload touches
 * anything. The rows it deletes are the only copy of these decisions; a
 * snapshot that lives in a JavaScript array dies with the request that is doing
 * the deleting, which is exactly the failure this table exists to prevent.
 *
 * Returns how many rows are confirmed written. Callers should refuse to delete
 * if this throws.
 */
export async function snapshotManualAssignments(
  supabase: SupabaseClient,
  uploadId: string
): Promise<number> {
  const allTxs: Array<MatchKeyed & { id: string; cost_center_id: string; assignment_origin: string }> = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("pl_transactions")
      .select(`${MATCH_SELECT}, cost_center_id, assignment_origin`)
      .eq("upload_id", uploadId)
      .in("assignment_origin", ["manual", "conflict_resolved"])
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`snapshot fetch txs: ${error.message}`);
    if (!data || data.length === 0) break;
    allTxs.push(...(data as typeof allTxs));
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  if (allTxs.length === 0) return 0;

  const txIds = allTxs.map((t) => t.id);

  // Transaction-level splits, so the reapply can recreate them from the table
  // rather than from memory.
  //
  // Chunking the ids is NOT enough on its own: one transaction can carry
  // several splits, so 500 ids can answer with well over the 1000-row cap
  // (measured on this project: an unbounded select returns exactly 1000 of
  // 26,165). A truncated answer here loses splits silently, and the loss only
  // shows up after the original rows have already been deleted. So each chunk
  // is also paged until it comes up short.
  const splitsMap = new Map<string, Array<{ cost_center_id: string; percentage: number; is_operational: boolean }>>();
  for (let i = 0; i < txIds.length; i += CHUNK) {
    const chunk = txIds.slice(i, i + CHUNK);
    let from = 0;
    while (true) {
      const { data: splits, error: splitsErr } = await supabase
        .from("cc_allocation_splits")
        .select("id, assign_value, cost_center_id, percentage, is_operational")
        .eq("assign_type", "transaction")
        .in("assign_value", chunk)
        .order("id", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (splitsErr) throw new Error(`snapshot fetch splits: ${splitsErr.message}`);
      if (!splits || splits.length === 0) break;
      for (const s of splits as Array<{ assign_value: string; cost_center_id: string; percentage: number; is_operational: boolean }>) {
        const arr = splitsMap.get(s.assign_value) ?? [];
        arr.push({ cost_center_id: s.cost_center_id, percentage: s.percentage, is_operational: s.is_operational });
        splitsMap.set(s.assign_value, arr);
      }
      if (splits.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
  }

  const conflictIds = allTxs.filter((t) => t.assignment_origin === "conflict_resolved").map((t) => t.id);
  const snapshotMap = new Map<string, { conflicting_cc_ids: string[]; resolved_cc_id: string; resolved_at: string }>();
  for (let i = 0; i < conflictIds.length; i += CHUNK) {
    const chunk = conflictIds.slice(i, i + CHUNK);
    const { data: snapshots, error: snapErr } = await supabase
      .from("conflict_snapshots")
      .select("transaction_id, conflicting_cc_ids, resolved_cc_id, resolved_at")
      .in("transaction_id", chunk)
      .eq("is_resolved", true);
    if (snapErr) throw new Error(`snapshot fetch conflict_snapshots: ${snapErr.message}`);
    for (const snap of (snapshots ?? []) as Array<{ transaction_id: string; conflicting_cc_ids: string[]; resolved_cc_id: string; resolved_at: string }>) {
      snapshotMap.set(snap.transaction_id, {
        conflicting_cc_ids: snap.conflicting_cc_ids ?? [],
        resolved_cc_id: snap.resolved_cc_id,
        resolved_at: snap.resolved_at,
      });
    }
  }

  const rows = allTxs.map((tx) => ({
    replaced_upload_id: uploadId,
    gl_code: tx.gl_code,
    branch: tx.branch,
    check_description: tx.check_description,
    journal_post_date: tx.journal_post_date,
    year: tx.year,
    month: tx.month,
    debit: tx.debit,
    credit: tx.credit,
    assignment_origin: tx.assignment_origin,
    cost_center_id: tx.cost_center_id,
    source_tx_id: tx.id,
    conflict_snapshot: snapshotMap.get(tx.id) ?? null,
    splits: splitsMap.get(tx.id) ?? [],
    status: "pending",
  }));

  // upsert on (replaced_upload_id, source_tx_id): re-running the snapshot for
  // the same upload refreshes the rows instead of duplicating them.
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase
      .from(BACKUP_TABLE)
      .upsert(rows.slice(i, i + CHUNK), { onConflict: "replaced_upload_id,source_tx_id" });
    if (error) throw new Error(`snapshot write backup: ${error.message}`);
  }

  // Read back rather than trusting that the write returned no error. Nothing
  // may be deleted until the backup is provably on disk, so this count is the
  // caller's evidence and a mismatch is fatal.
  const { count, error: verifyErr } = await supabase
    .from(BACKUP_TABLE)
    .select("*", { count: "exact", head: true })
    .eq("replaced_upload_id", uploadId);
  if (verifyErr) throw new Error(`snapshot verify backup: ${verifyErr.message}`);
  if ((count ?? 0) < rows.length) {
    throw new Error(
      `snapshot verify backup: se esperaban ${rows.length} filas respaldadas y hay ${count ?? 0}. ` +
      `No se borra nada.`
    );
  }

  return rows.length;
}

/**
 * Reapplies backed-up assignments onto the newly inserted transactions.
 *
 * Reads from the backup table, not from an argument: that is what makes it
 * resumable. A request that dies part-way leaves rows in 'pending', and the
 * next run finds them. Rows already marked 'applied' are never looked at
 * again, so running it twice is a no-op rather than a double write.
 *
 * Matching is all-or-nothing per assignment:
 *   1 match  → apply
 *   0 matches→ not_found, nothing written
 *   2+ matches→ ambiguous, NOTHING WRITTEN to any candidate, and the candidate
 *               ids are recorded so a human can decide.
 *
 * The last case is the point of the rewrite. Picking "the first" or painting
 * every candidate would spread one hand-made decision across expenses that
 * merely look alike.
 */
export async function reapplyManualSnapshot(
  supabase: SupabaseClient,
  newUploadId: string,
  replacedUploadId: string
): Promise<ManualAssignmentSummary> {
  const summary: ManualAssignmentSummary = {
    total_snapshotted: 0,
    manual_reapplied: 0,
    manual_not_found: 0,
    manual_requires_review: 0,
    conflict_resolved_reapplied: 0,
    conflict_resolved_not_found: 0,
    conflict_resolved_requires_review: 0,
  };

  // Only 'pending' rows: anything already resolved stays resolved.
  const pending: BackupRow[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from(BACKUP_TABLE)
      .select("*")
      .eq("replaced_upload_id", replacedUploadId)
      .eq("status", "pending")
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`reapply fetch backup: ${error.message}`);
    if (!data || data.length === 0) break;
    pending.push(...(data as BackupRow[]));
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  summary.total_snapshotted = pending.length;
  if (pending.length === 0) return summary;

  // New transactions, paginated past the PostgREST 1000-row cap.
  const newTxs: Array<MatchKeyed & { id: string }> = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("pl_transactions")
      .select(MATCH_SELECT)
      .eq("upload_id", newUploadId)
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(`reapply fetch new txs: ${error.message}`);
    if (!data || data.length === 0) break;
    newTxs.push(...(data as typeof newTxs));
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  // Index once by the full key. Every candidate for a key is kept, because the
  // count is what decides whether anything may be written at all.
  const byKey = new Map<string, string[]>();
  for (const tx of newTxs) {
    const k = matchKey(tx);
    const arr = byKey.get(k);
    if (arr) arr.push(tx.id);
    else byKey.set(k, [tx.id]);
  }

  const resolve = async (
    backupId: string,
    status: "applied" | "ambiguous" | "not_found",
    extra: { matched_tx_id?: string; candidate_tx_ids?: string[] } = {},
  ) => {
    const { error } = await supabase
      .from(BACKUP_TABLE)
      .update({
        status,
        new_upload_id: newUploadId,
        resolved_at: new Date().toISOString(),
        matched_tx_id: extra.matched_tx_id ?? null,
        candidate_tx_ids: extra.candidate_tx_ids ?? null,
      })
      .eq("id", backupId);
    if (error) throw new Error(`reapply mark ${status} ${backupId}: ${error.message}`);
  };

  for (const entry of pending) {
    const origin = entry.assignment_origin;
    const candidates = byKey.get(matchKey(entry)) ?? [];

    // ── 0 matches ──────────────────────────────────────────────────────────
    if (candidates.length === 0) {
      if (origin === "manual") summary.manual_not_found++;
      else summary.conflict_resolved_not_found++;
      await resolve(entry.id, "not_found");
      continue;
    }

    // ── 2 or more matches: write nothing, anywhere ─────────────────────────
    // No update, no split, no conflict snapshot — the loop moves on before any
    // write can happen. The candidate ids are stored so the ambiguity can be
    // resolved by hand instead of being lost to a counter.
    if (candidates.length > 1) {
      if (origin === "manual") summary.manual_requires_review++;
      else summary.conflict_resolved_requires_review++;
      await resolve(entry.id, "ambiguous", { candidate_tx_ids: candidates });
      continue;
    }

    // ── exactly 1 match ────────────────────────────────────────────────────
    const matchedId = candidates[0];

    const { error: updateErr } = await supabase
      .from("pl_transactions")
      .update({
        cost_center_id: entry.cost_center_id,
        assignment_origin: entry.assignment_origin,
        cost_center_status: "assigned",
        cost_center_conflicts: null,
        conflict_type: null,
      })
      .eq("id", matchedId);
    if (updateErr) throw new Error(`reapply update tx ${matchedId}: ${updateErr.message}`);

    // Delete-then-insert keeps this idempotent: a retry lands on the same rows
    // instead of stacking a second copy of the same splits.
    const { error: delSplitsErr } = await supabase
      .from("cc_allocation_splits")
      .delete()
      .eq("assign_type", "transaction")
      .eq("assign_value", matchedId);
    if (delSplitsErr) throw new Error(`reapply del splits ${matchedId}: ${delSplitsErr.message}`);

    const splits = Array.isArray(entry.splits) ? entry.splits : [];
    if (splits.length > 0) {
      const { error: insSplitsErr } = await supabase
        .from("cc_allocation_splits")
        .insert(
          splits.map((s) => ({
            assign_type: "transaction",
            assign_value: matchedId,
            cost_center_id: s.cost_center_id,
            percentage: s.percentage,
            is_operational: s.is_operational,
          }))
        );
      if (insSplitsErr) throw new Error(`reapply ins splits ${matchedId}: ${insSplitsErr.message}`);
    }

    if (origin === "conflict_resolved" && entry.conflict_snapshot) {
      const { error: snapErr } = await supabase
        .from("conflict_snapshots")
        .upsert(
          {
            transaction_id: matchedId,
            conflicting_cc_ids: entry.conflict_snapshot.conflicting_cc_ids,
            is_resolved: true,
            resolved_cc_id: entry.conflict_snapshot.resolved_cc_id,
            resolved_at: entry.conflict_snapshot.resolved_at,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "transaction_id" }
        );
      if (snapErr) throw new Error(`reapply upsert conflict_snapshot ${matchedId}: ${snapErr.message}`);
    }

    // Marked last: if anything above throws, the row stays 'pending' and the
    // next run retries it rather than recording a success that did not happen.
    await resolve(entry.id, "applied", { matched_tx_id: matchedId });

    if (origin === "manual") summary.manual_reapplied++;
    else summary.conflict_resolved_reapplied++;
  }

  return summary;
}
