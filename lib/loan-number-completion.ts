import type { createServerClient } from "@/lib/supabase-server";

/**
 * Derived from the server client rather than imported from supabase-js, whose
 * SupabaseClient defaults its schema parameter to "public". Since the data
 * moved to `finance_division` that default no longer matches what
 * createServerClient returns, and every caller would fail to type-check.
 * Deriving it keeps this in step with the client automatically — the same
 * pattern the other lib/ helpers already use.
 */
type SupabaseClient = ReturnType<typeof createServerClient>;

export interface CompletionStats {
  processed: number;
  completed_direct: number;
  completed_from_11: number;
  completed_from_10: number;
  completed_from_9: number;
  incomplete_no_match: number;
  incomplete_ambiguous: number;
}

/**
 * Scans all pl_transactions with a non-null loan_number_raw and resolves
 * each to a final loan_number using the loan_officials table as the master list.
 *
 * Rules:
 * - 12-digit raw → copy directly, loan_number_incomplete = false
 * - 10-digit raw with exactly 1 matching 12-digit loan (first 10 chars) →
 *     complete to 12 digits, loan_number_incomplete = false
 * - 9-digit raw with exactly 1 matching 12-digit loan (first 9 chars) →
 *     complete to 12 digits, loan_number_incomplete = false
 * - Otherwise (0 or 2+ matches) → keep raw value, loan_number_incomplete = true
 */
export async function runLoanNumberCompletion(
  supabase: SupabaseClient,
  options?: { uploadId?: string }
): Promise<CompletionStats> {
  // 1. Get all unique 12-digit loan numbers from loan_officials
  const { data: loansData, error: loansErr } = await supabase
    .from("loan_officials")
    .select("loan_number");

  if (loansErr) throw new Error(`loan_officials fetch: ${loansErr.message}`);

  const allLoanNumbers = [
    ...new Set(
      (loansData ?? [])
        .map((r: { loan_number: string }) => r.loan_number)
        .filter((n: string) => n && n.length === 12)
    ),
  ] as string[];

  // 2. Build prefix maps: first-11, first-10, and first-9-digits → [loan_numbers]
  const prefix11Map = new Map<string, string[]>();
  const prefix10Map = new Map<string, string[]>();
  const prefix9Map  = new Map<string, string[]>();
  for (const ln of allLoanNumbers) {
    const p11 = ln.slice(0, 11);
    const arr11 = prefix11Map.get(p11) ?? [];
    arr11.push(ln);
    prefix11Map.set(p11, arr11);

    const p10 = ln.slice(0, 10);
    const arr10 = prefix10Map.get(p10) ?? [];
    arr10.push(ln);
    prefix10Map.set(p10, arr10);

    const p9 = ln.slice(0, 9);
    const arr9 = prefix9Map.get(p9) ?? [];
    arr9.push(ln);
    prefix9Map.set(p9, arr9);
  }

  // 3. Fetch pl_transactions with loan_number_raw (scoped to uploadId if provided)
  const txs: { id: string; loan_number_raw: string }[] = [];
  let offset = 0;
  while (true) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = supabase
      .from("pl_transactions")
      .select("id,loan_number_raw")
      .not("loan_number_raw", "is", null);
    if (options?.uploadId) q = q.eq("upload_id", options.uploadId);
    const { data, error } = await q.order("id", { ascending: true }).range(offset, offset + 999);
    if (error) throw new Error(`pl_transactions fetch: ${error.message}`);
    if (!data || data.length === 0) break;
    txs.push(...(data as { id: string; loan_number_raw: string }[]));
    if (data.length < 1000) break;
    offset += 1000;
  }

  if (txs.length === 0) {
    return { processed: 0, completed_direct: 0, completed_from_11: 0, completed_from_10: 0, completed_from_9: 0, incomplete_no_match: 0, incomplete_ambiguous: 0 };
  }

  // 4. Compute outcome for each transaction
  type Update = { id: string; loan_number: string; loan_number_incomplete: boolean };
  const updates: Update[] = [];
  let completed_direct = 0;
  let completed_from_11 = 0;
  let completed_from_10 = 0;
  let completed_from_9 = 0;
  let incomplete_no_match = 0;
  let incomplete_ambiguous = 0;

  for (const tx of txs) {
    const raw = tx.loan_number_raw;

    if (raw.length === 12) {
      updates.push({ id: tx.id, loan_number: raw, loan_number_incomplete: false });
      completed_direct++;
    } else if (raw.length === 11) {
      const matches = prefix11Map.get(raw) ?? [];
      if (matches.length === 1) {
        updates.push({ id: tx.id, loan_number: matches[0], loan_number_incomplete: false });
        completed_from_11++;
      } else {
        updates.push({ id: tx.id, loan_number: raw, loan_number_incomplete: true });
        if (matches.length === 0) incomplete_no_match++;
        else incomplete_ambiguous++;
      }
    } else if (raw.length === 10) {
      const matches = prefix10Map.get(raw) ?? [];
      if (matches.length === 1) {
        updates.push({ id: tx.id, loan_number: matches[0], loan_number_incomplete: false });
        completed_from_10++;
      } else {
        updates.push({ id: tx.id, loan_number: raw, loan_number_incomplete: true });
        if (matches.length === 0) incomplete_no_match++;
        else incomplete_ambiguous++;
      }
    } else if (raw.length === 9) {
      const matches = prefix9Map.get(raw) ?? [];
      if (matches.length === 1) {
        updates.push({ id: tx.id, loan_number: matches[0], loan_number_incomplete: false });
        completed_from_9++;
      } else {
        updates.push({ id: tx.id, loan_number: raw, loan_number_incomplete: true });
        if (matches.length === 0) incomplete_no_match++;
        else incomplete_ambiguous++;
      }
    }
    // Other lengths are silently skipped
  }

  // 5. Batch update
  const CHUNK = 500;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    const { error } = await supabase.from("pl_transactions").upsert(
      chunk.map((u) => ({
        id: u.id,
        loan_number: u.loan_number,
        loan_number_incomplete: u.loan_number_incomplete,
      }))
    );
    if (error) throw new Error(`update chunk ${i}: ${error.message}`);
  }

  return {
    processed: txs.length,
    completed_direct,
    completed_from_11,
    completed_from_10,
    completed_from_9,
    incomplete_no_match,
    incomplete_ambiguous,
  };
}
