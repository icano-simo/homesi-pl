import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { extractLoanNumber } from "@/lib/normalize-pl";
import { runLoanNumberCompletion, type CompletionStats } from "@/lib/loan-number-completion";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

const CHUNK = 500;

export interface ReextractResult {
  scanned: number;
  extracted: number;
  completion: CompletionStats;
  examples: {
    id: string;
    check_description: string | null;
    loan_number_raw: string | null;
    loan_number: string | null;
    loan_number_incomplete: boolean | null;
  }[];
}

/**
 * POST — re-scans all pl_transactions where loan_number_raw IS NULL and
 * re-applies extractLoanNumber against check_description.
 * Rows where a number is found get their loan_number_raw set, then
 * runLoanNumberCompletion resolves them to final loan_number values.
 */
export async function POST(): Promise<NextResponse> {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const supabase = createServerClient();

  // 1. Fetch all transactions with null loan_number_raw but non-null check_description
  const rows: { id: string; check_description: string | null }[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("pl_transactions")
      .select("id, check_description")
      .is("loan_number_raw", null)
      .not("check_description", "is", null)
      .order("id", { ascending: true })
      .range(offset, offset + 999);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;
    rows.push(...(data as { id: string; check_description: string | null }[]));
    if (data.length < 1000) break;
    offset += 1000;
  }

  const scanned = rows.length;

  // 2. Re-apply extraction — group by extracted value to minimise DB round-trips
  const byRaw = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.check_description) continue;
    const raw = extractLoanNumber(row.check_description);
    if (raw) {
      const ids = byRaw.get(raw) ?? [];
      ids.push(row.id);
      byRaw.set(raw, ids);
    }
  }

  const extracted = [...byRaw.values()].reduce((s, ids) => s + ids.length, 0);
  const updatedIds: string[] = [];

  // 3. Batch-update loan_number_raw for the rows that matched
  for (const [raw, ids] of byRaw) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { error } = await supabase
        .from("pl_transactions")
        .update({ loan_number_raw: raw })
        .in("id", ids.slice(i, i + CHUNK));
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
    updatedIds.push(...ids);
  }

  // 4. Run completion to resolve newly-extracted raws to final loan_number values
  let completion: CompletionStats;
  try {
    completion = await runLoanNumberCompletion(supabase);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }

  // 5. Fetch a few example rows to return as proof
  let examples: ReextractResult["examples"] = [];
  if (updatedIds.length > 0) {
    const { data: exRows } = await supabase
      .from("pl_transactions")
      .select("id, check_description, loan_number_raw, loan_number, loan_number_incomplete")
      .in("id", updatedIds.slice(0, 20))
      .not("loan_number_raw", "is", null)
      .limit(5);
    examples = (exRows ?? []) as ReextractResult["examples"];
  }

  return NextResponse.json({ scanned, extracted, completion, examples } satisfies ReextractResult);
}
