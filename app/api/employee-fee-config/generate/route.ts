import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { generateEmployeeFeeLines } from "@/lib/generate-employee-fee-lines";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

// POST /api/employee-fee-config/generate
// Triggers initial generation of employee fee lines for one employee
// (or all not_recoverable employees if employeeName is omitted).
// Body: { employeeName?: string }
export async function POST(req: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const supabase = createServerClient();
  const body = await req.json() as { employeeName?: string };

  try {
    const result = await generateEmployeeFeeLines(supabase, {
      employeeName: body.employeeName,
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[employee-fee-config/generate]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
