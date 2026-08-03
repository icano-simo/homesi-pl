import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import type { VendorSummary } from "@/types";

export const dynamic = "force-dynamic";

const MONTH_ORDER = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

export async function GET(req: NextRequest) {
  const supabase = createServerClient();
  const { searchParams } = new URL(req.url);
  const branches = searchParams.getAll("branch");
  const months   = searchParams.getAll("month");
  const years    = searchParams.getAll("year").map(Number);

  // Fetch all relevant fields in pages
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all: any[] = [];
  let offset = 0;
  while (true) {
    let q = supabase
      .from("pl_transactions")
      .select("vendor,branch,month,year,gl_code,gl_name,cost_center_id,cost_center_status")
      .not("vendor", "is", null)
      .neq("vendor", "")
      .order("id", { ascending: true })
      .range(offset, offset + 999);
    if (branches.length > 0) q = q.in("branch", branches);
    if (months.length > 0)   q = q.in("month", months);
    if (years.length > 0)    q = q.in("year", years);
    const { data, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < 1000) break;
    offset += 1000;
  }

  // Fetch cost center names
  const { data: ccs } = await supabase.from("cost_centers").select("id,name");
  const ccMap = new Map<string, string>((ccs ?? []).map((c) => [c.id, c.name]));

  type Acc = {
    branches: Set<string>;
    months: Set<string>;
    years: Set<string>;
    gl_items: Map<string, { gl_code: string; gl_name: string }>;
    cc_labels: Set<string>;
    tx_count: number;
    tx_count_unassigned: number;
  };

  const byVendor = new Map<string, Acc>();
  const displayName = new Map<string, string>();

  for (const row of all) {
    if (!row.vendor) continue;
    const key = row.vendor.trim().replace(/\s+/g, " ").toLowerCase();
    if (!key) continue;

    if (!byVendor.has(key)) {
      byVendor.set(key, {
        branches: new Set(), months: new Set(), years: new Set(),
        gl_items: new Map(), cc_labels: new Set(),
        tx_count: 0, tx_count_unassigned: 0,
      });
      displayName.set(key, row.vendor.trim());
    }

    const acc = byVendor.get(key)!;
    acc.tx_count++;
    if (row.branch) acc.branches.add(row.branch.trim());
    if (row.month) acc.months.add(row.month);
    if (row.year) acc.years.add(String(row.year));
    if (row.gl_code) acc.gl_items.set(row.gl_code, { gl_code: row.gl_code, gl_name: row.gl_name ?? "" });

    if (row.cost_center_status === "unassigned" || !row.cost_center_id) {
      acc.cc_labels.add("Unassigned");
      acc.tx_count_unassigned++;
    } else if (row.cost_center_status === "conflict") {
      acc.cc_labels.add("Conflict");
      acc.tx_count_unassigned++;
    } else if (row.cost_center_id) {
      acc.cc_labels.add(ccMap.get(row.cost_center_id) ?? row.cost_center_id);
    }
  }

  const result: VendorSummary[] = [...byVendor.entries()]
    .map(([key, acc]) => ({
      vendor: displayName.get(key) ?? key,
      vendor_key: key,
      tx_count: acc.tx_count,
      tx_count_unassigned: acc.tx_count_unassigned,
      branches: [...acc.branches].sort(),
      months: MONTH_ORDER.filter((m) => acc.months.has(m)),
      years: [...acc.years].sort(),
      gl_items: [...acc.gl_items.values()].sort((a, b) => a.gl_code.localeCompare(b.gl_code)),
      cost_centers: [...acc.cc_labels].sort(),
    }))
    .sort((a, b) => a.vendor.localeCompare(b.vendor));

  return NextResponse.json(result);
}
