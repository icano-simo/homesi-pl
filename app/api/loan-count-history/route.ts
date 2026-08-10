import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { requireSession } from "@/lib/auth";

const MONTH_ORDER = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

export async function GET() {
  const supabase = createServerClient();

  const { data, error } = await supabase
    .from("loan_officials")
    .select("month, year, created_at, updated_at")
    .order("year", { ascending: false })
    .order("month", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Group by (month, year)
  const map = new Map<string, { month: string; year: number; count: number; last_updated: string }>();
  for (const row of data ?? []) {
    const key = `${row.month}|${row.year}`;
    const existing = map.get(key);
    const ts = row.updated_at ?? row.created_at ?? "";
    if (!existing) {
      map.set(key, { month: row.month, year: row.year, count: 1, last_updated: ts });
    } else {
      existing.count++;
      if (ts > existing.last_updated) existing.last_updated = ts;
    }
  }

  const periods = Array.from(map.values()).sort((a, b) => {
    if (b.year !== a.year) return b.year - a.year;
    return MONTH_ORDER.indexOf(b.month) - MONTH_ORDER.indexOf(a.month);
  });

  return NextResponse.json(periods);
}

export async function DELETE(req: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { searchParams } = new URL(req.url);
  const month = searchParams.get("month");
  const year = searchParams.get("year");

  if (!month || !year) {
    return NextResponse.json({ error: "month and year are required" }, { status: 400 });
  }

  const supabase = createServerClient();
  const { error, count } = await supabase
    .from("loan_officials")
    .delete({ count: "exact" })
    .eq("month", month)
    .eq("year", Number(year));

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ deleted: count ?? 0 });
}
