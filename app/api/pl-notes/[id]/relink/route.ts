import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { txFingerprint, FINGERPRINT_SELECT, type FingerprintableTx } from "@/lib/tx-fingerprint";

export const dynamic = "force-dynamic";

const SELECT =
  "id,level,scope,scope_key,transaction_id,tx_fingerprint,orphaned_at,note_text,author,created_at,updated_at";

/**
 * Manually reattaches an orphaned note to a transaction the user picked.
 *
 * Used when the automatic sweep could not decide — either nothing matched the
 * stored fingerprint, or several transactions did and guessing was refused.
 * The fingerprint is recomputed from the chosen row so the note can survive the
 * next re-upload on its own, and orphaned_at is cleared by the table trigger.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing note id" }, { status: 400 });

  let body: { transaction_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.transaction_id) {
    return NextResponse.json({ error: "transaction_id is required" }, { status: 400 });
  }

  const supabase = createServerClient();

  const { data: tx } = await supabase
    .from("pl_transactions")
    .select(FINGERPRINT_SELECT)
    .eq("id", body.transaction_id)
    .single();

  if (!tx) return NextResponse.json({ error: "Transaction not found" }, { status: 404 });

  const { data, error } = await supabase
    .from("pl_notes")
    .update({
      transaction_id: body.transaction_id,
      tx_fingerprint: txFingerprint(tx as unknown as FingerprintableTx),
    })
    .eq("id", id)
    .select(SELECT)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data)  return NextResponse.json({ error: "Note not found" }, { status: 404 });
  return NextResponse.json(data);
}
