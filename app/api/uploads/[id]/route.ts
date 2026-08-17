import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { deleteUpload } from "@/lib/check-duplicate-upload";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing upload id" }, { status: 400 });

  const supabase = createServerClient();

  // Verify the upload exists before deleting
  const { data: upload, error: fetchErr } = await supabase
    .from("pl_uploads")
    .select("id,file_name,row_count")
    .eq("id", id)
    .single();

  if (fetchErr || !upload) {
    return NextResponse.json({ error: "Upload not found" }, { status: 404 });
  }

  // deleteUpload throws on any step that fails, and an uncaught throw here
  // leaves Next to answer with something that is not the JSON the client
  // parses — so the browser saw an exception instead of a message, showed
  // nothing, and left the row on screen. Whatever goes wrong now comes back
  // as an error the user can read.
  try {
    await deleteUpload(supabase, id);
  } catch (e) {
    return NextResponse.json(
      { error: `Could not delete "${upload.file_name}": ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ deleted: true, upload_id: id });
}
