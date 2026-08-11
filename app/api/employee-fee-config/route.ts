import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET /api/employee-fee-config
// Returns all employee_fee_config rows.
export async function GET() {
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("employee_fee_config")
    .select("id, check_description_3, not_recoverable, fee_amount, created_at, updated_at")
    .order("check_description_3");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

// PATCH /api/employee-fee-config
// Upserts a single config row by check_description_3.
// Body: { check_description_3: string; not_recoverable: boolean; fee_amount: number | null }
export async function PATCH(req: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const supabase = createServerClient();
  const body = await req.json() as {
    check_description_3: string;
    not_recoverable: boolean;
    fee_amount: number | null;
  };

  if (!body.check_description_3) {
    return NextResponse.json({ error: "check_description_3 is required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("employee_fee_config")
    .upsert(
      {
        check_description_3: body.check_description_3,
        not_recoverable:     body.not_recoverable,
        fee_amount:          body.fee_amount,
        updated_at:          new Date().toISOString(),
      },
      { onConflict: "check_description_3" },
    )
    .select("id, check_description_3, not_recoverable, fee_amount")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
