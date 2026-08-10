import { txFingerprint, groupByFingerprint, FINGERPRINT_SELECT, type FingerprintableTx } from "@/lib/tx-fingerprint";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

import type { RelinkSummary } from "@/types";

export type { RelinkSummary };

const PAGE_SIZE = 1000;
const CHUNK = 200;

export const EMPTY_RELINK: RelinkSummary = {
  notesConsidered: 0, notesRelinked: 0, notesOrphaned: 0, notesAmbiguous: 0,
};

/**
 * Reattaches transaction-level notes that lost their transaction to the rows of
 * a freshly inserted upload.
 *
 * Replacing a month hard-deletes pl_transactions, and pl_notes.transaction_id
 * is ON DELETE SET NULL, so the note survives detached. This is what finds it a
 * new home.
 *
 * Runs on every upload, not only replacements: the notes table is tiny, and
 * sweeping all orphans means a note stranded by an earlier replace is healed as
 * soon as its transaction reappears in any later file.
 *
 * Never guesses. A fingerprint matching several new transactions leaves the note
 * orphaned — identical lines on the same day are normal in a GL detail, and
 * moving somebody's comment onto the wrong transaction is worse than leaving it
 * visible in the orphan panel for a human to place.
 */
export async function relinkOrphanNotes(
  supabase: SupabaseClient,
  newUploadId: string,
): Promise<RelinkSummary> {
  const summary: RelinkSummary = { ...EMPTY_RELINK };

  const { data: orphanRows, error: orphanErr } = await supabase
    .from("pl_notes")
    .select("id,tx_fingerprint,orphaned_at")
    .is("transaction_id", null)
    .not("tx_fingerprint", "is", null);

  if (orphanErr) throw new Error(`relink fetch orphans: ${orphanErr.message}`);

  const orphans = (orphanRows ?? []) as Array<{
    id: string; tx_fingerprint: string; orphaned_at: string | null;
  }>;
  summary.notesConsidered = orphans.length;
  if (orphans.length === 0) return summary;

  // Fingerprints of the rows just inserted.
  const newTxs: Array<FingerprintableTx & { id: string }> = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("pl_transactions")
      .select(`id,${FINGERPRINT_SELECT}`)
      .eq("upload_id", newUploadId)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`relink fetch new txs: ${error.message}`);
    if (!data || data.length === 0) break;
    newTxs.push(...(data as Array<FingerprintableTx & { id: string }>));
    if (data.length < PAGE_SIZE) break;
  }

  const byFingerprint = groupByFingerprint(newTxs);

  const toLink: Array<{ id: string; transaction_id: string }> = [];
  const toStamp: string[] = [];

  for (const note of orphans) {
    const candidates = byFingerprint.get(note.tx_fingerprint) ?? [];

    if (candidates.length === 1) {
      toLink.push({ id: note.id, transaction_id: candidates[0] });
      summary.notesRelinked++;
      continue;
    }

    if (candidates.length > 1) summary.notesAmbiguous++;
    else summary.notesOrphaned++;

    // Backstop for rows detached before the orphaned_at trigger existed. Rows
    // orphaned since then were stamped at the moment of the delete, which is
    // the truthful time — do not overwrite it with "now".
    if (!note.orphaned_at) toStamp.push(note.id);
  }

  // The trigger clears orphaned_at automatically when transaction_id is set.
  for (let i = 0; i < toLink.length; i += CHUNK) {
    await Promise.all(
      toLink.slice(i, i + CHUNK).map((l) =>
        supabase.from("pl_notes").update({ transaction_id: l.transaction_id }).eq("id", l.id)
      )
    );
  }

  for (let i = 0; i < toStamp.length; i += CHUNK) {
    const chunk = toStamp.slice(i, i + CHUNK);
    const { error } = await supabase
      .from("pl_notes")
      .update({ orphaned_at: new Date().toISOString() })
      .in("id", chunk);
    if (error) throw new Error(`relink stamp orphans: ${error.message}`);
  }

  return summary;
}

/** Recomputes the fingerprint of one transaction — used when re-linking by hand. */
export function fingerprintOf(tx: FingerprintableTx): string {
  return txFingerprint(tx);
}
