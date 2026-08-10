import { NextRequest, NextResponse } from "next/server";
import { parseMappingFile } from "@/lib/parse-mapping";
import { createServerClient } from "@/lib/supabase-server";
import { requireSession } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    let parseResult;
    try {
      parseResult = parseMappingFile(buffer);
    } catch (parseErr) {
      return NextResponse.json(
        { error: `Failed to parse mapping file: ${String(parseErr)}` },
        { status: 422 }
      );
    }

    const { glMappings, branches, debug } = parseResult;
    const supabase = createServerClient();

    let glUpsertError: string | null = null;
    if (glMappings.length > 0) {
      const { error } = await supabase
        .from("gl_mapping")
        .upsert(glMappings, { onConflict: "gl_code" });
      if (error) glUpsertError = error.message;
    }

    let branchUpsertError: string | null = null;
    if (branches.length > 0) {
      const { error } = await supabase
        .from("branches")
        .upsert(branches, { onConflict: "branch" });
      if (error) branchUpsertError = error.message;
    }

    return NextResponse.json({
      glMappingsImported: glMappings.length,
      branchesImported: branches.length,
      glUpsertError,
      branchUpsertError,
      // Column detection snapshot — use this to verify all 7 categories were found
      debug,
    });
  } catch (err) {
    console.error("[upload-mapping]", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
