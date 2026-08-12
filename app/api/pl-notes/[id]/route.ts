import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

const SELECT =
  "id,level,scope,scope_key,transaction_id,tx_fingerprint,orphaned_at,note_text,author,created_at,updated_at";

/** Edit a note's text. The anchor (level/scope) is immutable — a note that
 *  needs a different anchor is a different note. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing note id" }, { status: 400 });

  let body: { note_text?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const noteText = body.note_text?.trim();
  if (!noteText) return NextResponse.json({ error: "note_text is required" }, { status: 400 });

  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("pl_notes")
    .update({ note_text: noteText })
    .eq("id", id)
    .select(SELECT)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data)  return NextResponse.json({ error: "Note not found" }, { status: 404 });
  return NextResponse.json(data);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing note id" }, { status: 400 });

  const supabase = createServerClient();
  const { error } = await supabase.from("pl_notes").delete().eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ deleted: true, id });
}
