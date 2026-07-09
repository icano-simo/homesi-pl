// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

import type { ManualAssignmentSummary } from "@/types";

interface ManualAssignmentEntry {
  gl_code:           string | null;
  branch:            string | null;
  check_description: string | null;
  journal_post_date: string | null;
  cost_center_id:    string;
  assignment_origin: "manual" | "conflict_resolved";
  conflict_snapshot?: {
    conflicting_cc_ids: string[];
    resolved_cc_id:     string;
    resolved_at:        string;
  };
  splits: Array<{
    cost_center_id: string;
    percentage:     number;
    is_operational: boolean;
  }>;
}

const CHUNK    = 500;
const PAGE_SIZE = 1000;

/**
 * Reads all manual and conflict_resolved transactions for an upload,
 * captures their cost center assignments, splits, and conflict snapshots.
 * Call this BEFORE deleteUpload when replacing an upload.
 */
export async function snapshotManualAssignments(
  supabase: SupabaseClient,
  uploadId: string
): Promise<ManualAssignmentEntry[]> {
  // Paginate in case the upload has many manual assignments
  const allTxs: Array<{
    id: string;
    gl_code: string | null;
    branch: string | null;
    check_description: string | null;
    journal_post_date: string | null;
    cost_center_id: string;
    assignment_origin: string;
  }> = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("pl_transactions")
      .select("id, gl_code, branch, check_description, journal_post_date, cost_center_id, assignment_origin")
      .eq("upload_id", uploadId)
      .in("assignment_origin", ["manual", "conflict_resolved"])
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`snapshot fetch txs: ${error.message}`);
    if (!data || data.length === 0) break;
    allTxs.push(...(data as typeof allTxs));
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  if (allTxs.length === 0) return [];

  const txList = allTxs as Array<{
    id: string;
    gl_code: string | null;
    branch: string | null;
    check_description: string | null;
    journal_post_date: string | null;
    cost_center_id: string;
    assignment_origin: string;
  }>;
  const txIds = txList.map((t) => t.id);

  // Fetch transaction-level cc_allocation_splits in chunks
  const splitsMap = new Map<string, Array<{ cost_center_id: string; percentage: number; is_operational: boolean }>>();
  for (let i = 0; i < txIds.length; i += CHUNK) {
    const chunk = txIds.slice(i, i + CHUNK);
    const { data: splits, error: splitsErr } = await supabase
      .from("cc_allocation_splits")
      .select("assign_value, cost_center_id, percentage, is_operational")
      .eq("assign_type", "transaction")
      .in("assign_value", chunk);
    if (splitsErr) throw new Error(`snapshot fetch splits: ${splitsErr.message}`);
    for (const s of (splits ?? []) as Array<{ assign_value: string; cost_center_id: string; percentage: number; is_operational: boolean }>) {
      const arr = splitsMap.get(s.assign_value) ?? [];
      arr.push({ cost_center_id: s.cost_center_id, percentage: s.percentage, is_operational: s.is_operational });
      splitsMap.set(s.assign_value, arr);
    }
  }

  // Fetch conflict_snapshots for conflict_resolved transactions
  const conflictIds = txList.filter((t) => t.assignment_origin === "conflict_resolved").map((t) => t.id);
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
        resolved_cc_id:     snap.resolved_cc_id,
        resolved_at:        snap.resolved_at,
      });
    }
  }

  return txList.map((tx) => ({
    gl_code:           tx.gl_code,
    branch:            tx.branch,
    check_description: tx.check_description,
    journal_post_date: tx.journal_post_date,
    cost_center_id:    tx.cost_center_id,
    assignment_origin: tx.assignment_origin as "manual" | "conflict_resolved",
    conflict_snapshot: snapshotMap.get(tx.id),
    splits:            splitsMap.get(tx.id) ?? [],
  }));
}

/**
 * Matches snapshotted manual assignments onto newly inserted transactions
 * using the 4-field composite key (gl_code, branch, check_description, journal_post_date).
 * Call this AFTER cost center rules are applied to the new upload.
 *
 * Matching rules:
 *   - 0 matches → not_found
 *   - 2+ matches → requires_review (ambiguous; leave as rule-assigned)
 *   - 1 match   → re-apply the manual assignment (overwrites rule result)
 */
export async function reapplyManualSnapshot(
  supabase: SupabaseClient,
  newUploadId: string,
  snapshot: ManualAssignmentEntry[]
): Promise<ManualAssignmentSummary> {
  const summary: ManualAssignmentSummary = {
    total_snapshotted:                 snapshot.length,
    manual_reapplied:                  0,
    manual_not_found:                  0,
    manual_requires_review:            0,
    conflict_resolved_reapplied:       0,
    conflict_resolved_not_found:       0,
    conflict_resolved_requires_review: 0,
  };

  if (snapshot.length === 0) return summary;

  // Fetch all new transactions for key matching
  const { data: newTxs, error: fetchErr } = await supabase
    .from("pl_transactions")
    .select("id, gl_code, branch, check_description, journal_post_date")
    .eq("upload_id", newUploadId);

  if (fetchErr) throw new Error(`reapply fetch new txs: ${fetchErr.message}`);

  const txList = (newTxs ?? []) as Array<{
    id: string;
    gl_code: string | null;
    branch: string | null;
    check_description: string | null;
    journal_post_date: string | null;
  }>;

  for (const entry of snapshot) {
    const origin = entry.assignment_origin;

    const matches = txList.filter(
      (tx) =>
        tx.gl_code           === entry.gl_code &&
        tx.branch            === entry.branch &&
        tx.check_description === entry.check_description &&
        tx.journal_post_date === entry.journal_post_date
    );

    if (matches.length === 0) {
      if (origin === "manual") summary.manual_not_found++;
      else summary.conflict_resolved_not_found++;
      continue;
    }

    if (matches.length > 1) {
      if (origin === "manual") summary.manual_requires_review++;
      else summary.conflict_resolved_requires_review++;
      continue;
    }

    const matchedId = matches[0].id;

    // Re-apply cost center assignment
    const { error: updateErr } = await supabase
      .from("pl_transactions")
      .update({
        cost_center_id:        entry.cost_center_id,
        assignment_origin:     entry.assignment_origin,
        cost_center_status:    "assigned",
        cost_center_conflicts: null,
        conflict_type:         null,
      })
      .eq("id", matchedId);
    if (updateErr) throw new Error(`reapply update tx ${matchedId}: ${updateErr.message}`);

    // Recreate transaction-level splits (delete existing first)
    const { error: delSplitsErr } = await supabase
      .from("cc_allocation_splits")
      .delete()
      .eq("assign_type", "transaction")
      .eq("assign_value", matchedId);
    if (delSplitsErr) throw new Error(`reapply del splits ${matchedId}: ${delSplitsErr.message}`);

    if (entry.splits.length > 0) {
      const { error: insSplitsErr } = await supabase
        .from("cc_allocation_splits")
        .insert(
          entry.splits.map((s) => ({
            assign_type:    "transaction",
            assign_value:   matchedId,
            cost_center_id: s.cost_center_id,
            percentage:     s.percentage,
            is_operational: s.is_operational,
          }))
        );
      if (insSplitsErr) throw new Error(`reapply ins splits ${matchedId}: ${insSplitsErr.message}`);
    }

    // For conflict_resolved: recreate conflict_snapshot row with the new transaction_id
    if (origin === "conflict_resolved" && entry.conflict_snapshot) {
      const { error: snapErr } = await supabase
        .from("conflict_snapshots")
        .upsert(
          {
            transaction_id:     matchedId,
            conflicting_cc_ids: entry.conflict_snapshot.conflicting_cc_ids,
            is_resolved:        true,
            resolved_cc_id:     entry.conflict_snapshot.resolved_cc_id,
            resolved_at:        entry.conflict_snapshot.resolved_at,
            updated_at:         new Date().toISOString(),
          },
          { onConflict: "transaction_id" }
        );
      if (snapErr) throw new Error(`reapply upsert conflict_snapshot ${matchedId}: ${snapErr.message}`);
    }

    if (origin === "manual") summary.manual_reapplied++;
    else summary.conflict_resolved_reapplied++;
  }

  return summary;
}
