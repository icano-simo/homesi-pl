import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = createServerClient();

  // Paginated for the same reason the list is: an option missing from a
  // dropdown because the fetch stopped at 1000 rows looks exactly like a filter
  // that does not work.
  const PAGE = 1000;
  const data: Array<{ month: string | null; year: number | null }> = [];
  for (let from = 0; ; from += PAGE) {
    const { data: rows, error } = await supabase
      .from("loan_officials")
      .select("month,year")
      .order("year")
      .order("month")
      .range(from, from + PAGE - 1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!rows || rows.length === 0) break;
    data.push(...rows);
    if (rows.length < PAGE) break;
  }

  const months = [...new Set((data ?? []).map((r: { month: string | null }) => r.month).filter(Boolean))] as string[];
  const years = [...new Set((data ?? []).map((r: { year: number | null }) => r.year).filter((y) => y != null))] as number[];

  // Ya no devuelve branches: su unico consumidor era el desplegable Branch de la
  // barra de Loan Validation, que se fue con la pestaña B2B. Devolverlo sin que
  // nadie lo lea es traer una columna mas de 436 filas para tirarla.
  return NextResponse.json({ months, years });
}
