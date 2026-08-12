// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

export type DuplicateInfo = {
  upload_id: string;
  file_name: string;
  uploaded_at: string;
  row_count: number | null;
  overlap: string[]; // e.g. ["January 2025", "February 2025"]
};

export type DuplicateCheckResult =
  | { found: false }
  | { found: true; info: DuplicateInfo };

/**
 * Checks whether an existing upload of the same source type covers any of the
 * same month+year combinations as the rows being uploaded now.
 * Returns the most-overlapping existing upload if found.
 */
export async function checkDuplicateUpload(
  supabase: SupabaseClient,
  source: "original" | "addback" | "offshore_allocations",
  rows: Array<{ month: string | null; year: number | null }>
): Promise<DuplicateCheckResult> {
  const months = [...new Set(rows.map((r) => r.month).filter(Boolean))] as string[];
  const years  = [...new Set(rows.map((r) => r.year).filter(Boolean))]  as number[];

  if (months.length === 0 || years.length === 0) return { found: false };

  // Find existing transactions of the same source type with overlapping months/years
  const { data: existing } = await supabase
    .from("pl_transactions")
    .select("upload_id,month,year")
    .eq("source", source)
    .in("month", months)
    .in("year", years)
    .limit(2000);

  if (!existing || existing.length === 0) return { found: false };

  // Count rows per upload_id and collect the overlap labels
  const countByUpload  = new Map<string, number>();
  const overlapByUpload = new Map<string, Set<string>>();

  for (const row of existing as { upload_id: string; month: string; year: number }[]) {
    const uid = row.upload_id;
    if (!uid) continue;
    countByUpload.set(uid, (countByUpload.get(uid) ?? 0) + 1);
    if (!overlapByUpload.has(uid)) overlapByUpload.set(uid, new Set());
    if (row.month && row.year) overlapByUpload.get(uid)!.add(`${row.month} ${row.year}`);
  }

  if (countByUpload.size === 0) return { found: false };

  // Take the upload with the most overlapping rows (most likely the duplicate)
  const bestId = [...countByUpload.entries()].sort((a, b) => b[1] - a[1])[0][0];

  const { data: upload } = await supabase
    .from("pl_uploads")
    .select("id,file_name,uploaded_at,row_count")
    .eq("id", bestId)
    .single();

  if (!upload) return { found: false };

  return {
    found: true,
    info: {
      upload_id: upload.id,
      file_name: upload.file_name,
      uploaded_at: upload.uploaded_at,
      row_count: upload.row_count,
      overlap: [...(overlapByUpload.get(bestId) ?? [])].sort(),
    },
  };
}

const DELETE_CHUNK = 500;

const SELECT_PAGE = 1000;

/**
 * Deletes an upload and all associated rows.
 * Cleans up related tables first to avoid orphaned rows:
 * conflict_snapshots → cc_allocation_splits (transaction) → pl_transactions → pl_uploads
 *
 * CALLER CONTRACT: everything worth keeping from this upload must already be
 * backed up and confirmed on disk. See snapshotManualAssignments — these rows
 * are the only copy of the manual assignments and there is no rollback here.
 *
 * Every delete is chunked. authenticator runs with statement_timeout = 8s, and
 * uploads of 11,092 and 13,848 rows exist, so removing pl_transactions in one
 * statement is a real failure mode rather than a theoretical one — and a
 * timeout half-way through leaves the upload partly deleted, since none of this
 * is in a transaction.
 */
export async function deleteUpload(supabase: SupabaseClient, uploadId: string): Promise<void> {
  // Paginate the id fetch too: without a range this silently stops at the
  // PostgREST 1000-row cap, and the children of every row past that would be
  // left behind.
  const txIds: string[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("pl_transactions")
      .select("id")
      .eq("upload_id", uploadId)
      .order("id", { ascending: true })
      .range(from, from + SELECT_PAGE - 1);
    if (error) throw new Error(`deleteUpload fetch ids: ${error.message}`);
    if (!data || data.length === 0) break;
    txIds.push(...data.map((r: { id: string }) => r.id));
    if (data.length < SELECT_PAGE) break;
    from += SELECT_PAGE;
  }

  if (txIds.length > 0) {
    for (let i = 0; i < txIds.length; i += DELETE_CHUNK) {
      const chunk = txIds.slice(i, i + DELETE_CHUNK);

      // Redundant for correctness — conflict_snapshots.transaction_id is
      // ON DELETE CASCADE — but kept deliberately. It moves that cascade work
      // out of the pl_transactions delete below, which is the statement at
      // risk of the 8s timeout, and the loop has to exist anyway for
      // cc_allocation_splits, whose assign_value is plain text with no foreign
      // key and therefore no cascade of its own.
      const { error: snapErr } = await supabase
        .from("conflict_snapshots").delete().in("transaction_id", chunk);
      if (snapErr) throw new Error(`deleteUpload conflict_snapshots: ${snapErr.message}`);

      const { error: splitErr } = await supabase
        .from("cc_allocation_splits")
        .delete()
        .eq("assign_type", "transaction")
        .in("assign_value", chunk);
      if (splitErr) throw new Error(`deleteUpload cc_allocation_splits: ${splitErr.message}`);
    }

    // Chunked by explicit id list rather than one statement over upload_id.
    for (let i = 0; i < txIds.length; i += DELETE_CHUNK) {
      const chunk = txIds.slice(i, i + DELETE_CHUNK);
      const { error } = await supabase.from("pl_transactions").delete().in("id", chunk);
      if (error) throw new Error(`deleteUpload pl_transactions: ${error.message}`);
    }
  }

  // Sweeps anything inserted between the id fetch and now, so the parent row
  // never fails to delete on a leftover child.
  const { error: tailErr } = await supabase
    .from("pl_transactions").delete().eq("upload_id", uploadId);
  if (tailErr) throw new Error(`deleteUpload pl_transactions tail: ${tailErr.message}`);

  const { error: uploadErr } = await supabase.from("pl_uploads").delete().eq("id", uploadId);
  if (uploadErr) throw new Error(`deleteUpload pl_uploads: ${uploadErr.message}`);
}
