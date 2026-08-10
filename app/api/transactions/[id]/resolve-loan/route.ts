import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { requireSession } from "@/lib/auth";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const { loan_number } = body as { loan_number?: string };

  if (!loan_number || typeof loan_number !== "string" || !/^\d{12}$/.test(loan_number)) {
    return NextResponse.json(
      { error: "loan_number must be a 12-digit numeric string" },
      { status: 400 }
    );
  }

  const supabase = createServerClient();
  const txId = id;

  // Update the transaction:
  //  - loan_number → the chosen 12-digit number
  //  - loan_number_raw → set to the same 12-digit value so future runLoanNumberCompletion
  //    runs treat this as a "direct 12-digit match" and don't overwrite the manual choice
  //  - loan_number_incomplete → false
  const { data, error } = await supabase
    .from("pl_transactions")
    .update({
      loan_number,
      loan_number_raw: loan_number,
      loan_number_incomplete: false,
    })
    .eq("id", txId)
    .select("id,loan_number,loan_number_raw,loan_number_incomplete")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
