import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import type { FilterOptionsResponse } from "@/types";

export const dynamic = "force-dynamic";

const MONTH_ORDER = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const CATEGORICAL_COLS = [
  "month", "year", "gl_code", "gl_name",
  "branch", "vendor", "category_5", "category_6", "ref_numb",
  "check_description_2", "check_description_3", "source",
] as const;
type CatCol = (typeof CATEGORICAL_COLS)[number];

// Paginates through all rows to collect every distinct value for a single column.
// Without pagination, PostgREST's default 1000-row limit would silently truncate results.
async function distinctValues(
  col: CatCol,
  uploadId: string | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any
): Promise<string[]> {
  const seen = new Set<string>();
  let offset = 0;
  const BATCH = 1000;

  while (true) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = supabase
      .from("pl_transactions")
      .select(col)
      .not(col, "is", null)
      .order("id", { ascending: true })
      .range(offset, offset + BATCH - 1);
    if (uploadId) q = q.eq("upload_id", uploadId);

    const { data } = await q;
    if (!data || data.length === 0) break;

    for (const row of data as Record<string, unknown>[]) {
      seen.add(String(row[col]));
    }
    if (data.length < BATCH) break;
    offset += BATCH;
  }

  return [...seen];
}

export async function GET(req: NextRequest) {
  const supabase = createServerClient();
  const uploadId = new URL(req.url).searchParams.get("uploadId");

  const [rawValues, { data: ccs }] = await Promise.all([
    Promise.all(CATEGORICAL_COLS.map((col) => distinctValues(col, uploadId, supabase))),
    supabase.from("cost_centers").select("id,name").order("name"),
  ]);

  const columns = Object.fromEntries(
    CATEGORICAL_COLS.map((col, i) => {
      const raw = rawValues[i];
      if (col === "month") {
        raw.sort((a: string, b: string) => MONTH_ORDER.indexOf(a) - MONTH_ORDER.indexOf(b));
      } else if (col === "year") {
        raw.sort((a: string, b: string) => Number(a) - Number(b));
      } else {
        raw.sort((a: string, b: string) => a.localeCompare(b));
      }
      return [col, raw];
    })
  ) as Record<CatCol, string[]>;

  const response: FilterOptionsResponse = {
    ...columns,
    costCenters: (ccs ?? []).map((cc: { id: string; name: string }) => ({
      id: cc.id,
      name: cc.name,
    })),
  };

  return NextResponse.json(response);
}
