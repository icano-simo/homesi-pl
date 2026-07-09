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

/**
 * Deletes an upload and all associated rows.
 * Cleans up related tables first to avoid orphaned rows:
 * conflict_snapshots → cc_allocation_splits (transaction) → pl_transactions → pl_uploads
 */
export async function deleteUpload(supabase: SupabaseClient, uploadId: string): Promise<void> {
  // Fetch all transaction IDs so we can clean up linked rows
  const { data: txRows } = await supabase
    .from("pl_transactions")
    .select("id")
    .eq("upload_id", uploadId);

  const txIds = (txRows ?? []).map((r: { id: string }) => r.id);

  if (txIds.length > 0) {
    for (let i = 0; i < txIds.length; i += DELETE_CHUNK) {
      const chunk = txIds.slice(i, i + DELETE_CHUNK);
      await supabase.from("conflict_snapshots").delete().in("transaction_id", chunk);
      await supabase
        .from("cc_allocation_splits")
        .delete()
        .eq("assign_type", "transaction")
        .in("assign_value", chunk);
    }
  }

  await supabase.from("pl_transactions").delete().eq("upload_id", uploadId);
  await supabase.from("pl_uploads").delete().eq("id", uploadId);
}
