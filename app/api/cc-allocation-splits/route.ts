import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import {
  buildVersionedSplitsMap,
  findApplicableVersion,
  toPeriod,
  txMonthPeriod,
  type SplitVersionRow,
} from "@/lib/split-version-utils";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

const CHUNK = 500;

function norm(v: string) {
  return v.trim().replace(/\s+/g, " ");
}

/**
 * GET — all splits (no params) OR versioned splits for one key (?type=&value=).
 *
 * "All splits" response: flat rows (unchanged — used by list/admin pages).
 * "Single key" response: { versions: [{ effective_from_year, effective_from_month, splits: [...] }] }
 *   sorted DESC by period. When ?include_rule=true and no versions found,
 *   falls back to the matching split rule's allocations as an initial version.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const type        = searchParams.get("type");
  const rawValue    = searchParams.get("value");
  const includeRule = searchParams.get("include_rule") === "true";

  const supabase = createServerClient();

  // "All splits" fetch (no type/value params) — paginate to bypass 1000-row limit.
  if (!(type && rawValue !== null)) {
    const PAGE_SIZE = 1000;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allData: any[] = [];
    let offset = 0;
    while (true) {
      const { data: page, error: pageErr } = await supabase
        .from("cc_allocation_splits")
        .select("id,assign_type,assign_value,cost_center_id,percentage,is_operational,created_at,effective_from_year,effective_from_month,cost_centers(name)")
        .order("percentage", { ascending: false })
        .order("id", { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);
      if (pageErr) return NextResponse.json({ error: pageErr.message }, { status: 500 });
      if (!page || page.length === 0) break;
      allData.push(...page);
      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
    return NextResponse.json(allData);
  }

  // Single-key lookup — group rows into versions and return DESC sorted.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = supabase
    .from("cc_allocation_splits")
    .select("assign_type,assign_value,cost_center_id,percentage,is_operational,created_at,effective_from_year,effective_from_month,cost_centers(name)")
    .order("percentage", { ascending: false });

  const normValueKey = norm(rawValue!);
  q = q.eq("assign_type", type);
  if (normValueKey !== rawValue) {
    q = q.in("assign_value", [rawValue, normValueKey]);
  } else {
    q = q.eq("assign_value", rawValue);
  }

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // If nothing found and caller wants a rule fallback, look for a matching split rule.
  if (includeRule && (!data || data.length === 0) && type && rawValue !== null) {
    const normValue = norm(rawValue);
    const conditionField = type === "vendor" ? "vendor" : "check_description_3";
    const lookupValues = normValue !== rawValue ? [rawValue, normValue] : [rawValue];

    const { data: condRows } = await supabase
      .from("split_rule_conditions")
      .select("split_rule_id")
      .eq("field", conditionField)
      .eq("operator", "equals")
      .in("value", lookupValues);

    if (condRows && condRows.length > 0) {
      const ruleId = (condRows as { split_rule_id: string }[])[0].split_rule_id;

      const { data: allocRows } = await supabase
        .from("split_rule_allocations")
        .select("cost_center_id,percentage,cost_centers(name)")
        .eq("split_rule_id", ruleId)
        .order("display_order");

      if (allocRows && allocRows.length > 0) {
        return NextResponse.json({
          versions: [{
            effective_from_year:  null,
            effective_from_month: null,
            splits: (allocRows as { cost_center_id: string; percentage: number; cost_centers: unknown }[])
              .map((a) => ({
                cost_center_id: a.cost_center_id,
                percentage:     a.percentage,
                is_operational: true,
                cost_centers:   a.cost_centers,
                created_at:     null,
              })),
          }],
        });
      }
    }
  }

  if (!data || data.length === 0) {
    return NextResponse.json({ versions: [] });
  }

  // Group rows by (effective_from_year, effective_from_month), sort DESC.
  type VersionObj = {
    effective_from_year: number | null;
    effective_from_month: number | null;
    splits: Array<{ cost_center_id: string; percentage: number; is_operational: boolean; cost_centers: unknown; created_at: string | null }>;
  };
  const versionMap = new Map<string, VersionObj>();
  for (const row of data as Array<{
    cost_center_id: string; percentage: number; is_operational: boolean | null;
    cost_centers: unknown; created_at: string | null;
    effective_from_year: number | null; effective_from_month: number | null;
  }>) {
    const pkey = `${row.effective_from_year ?? "N"}:${row.effective_from_month ?? "N"}`;
    if (!versionMap.has(pkey)) {
      versionMap.set(pkey, {
        effective_from_year:  row.effective_from_year ?? null,
        effective_from_month: row.effective_from_month ?? null,
        splits: [],
      });
    }
    versionMap.get(pkey)!.splits.push({
      cost_center_id: row.cost_center_id,
      percentage:     row.percentage,
      is_operational: row.is_operational ?? true,
      cost_centers:   row.cost_centers,
      created_at:     row.created_at ?? null,
    });
  }

  const versions = [...versionMap.values()].sort((a, b) => {
    const pa = a.effective_from_year == null ? 0 : a.effective_from_year * 100 + (a.effective_from_month ?? 0);
    const pb = b.effective_from_year == null ? 0 : b.effective_from_year * 100 + (b.effective_from_month ?? 0);
    return pb - pa;
  });

  return NextResponse.json({ versions });
}

/**
 * PUT — upsert one version of the allocation split for one (assign_type, assign_value) key.
 * Body: { assign_type, assign_value, effective_from_year?, effective_from_month?, splits }
 *
 * effective_from_year/month null or absent = "initial version" (applies from the beginning).
 * Propagates only to transactions whose applicable version matches this version's period.
 */
export async function PUT(req: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const body = await req.json() as {
    assign_type: "vendor" | "description3";
    assign_value: string;
    effective_from_year?: number | null;
    effective_from_month?: number | null;
    splits: { cost_center_id: string; percentage: number; is_operational?: boolean }[];
  };

  const { assign_type, splits } = body;
  const rawAssignValue    = body.assign_value;
  const effective_from_year  = body.effective_from_year  ?? null;
  const effective_from_month = body.effective_from_month ?? null;

  if (!assign_type || !rawAssignValue || !Array.isArray(splits) || splits.length === 0) {
    return NextResponse.json({ error: "assign_type, assign_value, and splits are required" }, { status: 400 });
  }

  const total = splits.reduce((s, r) => s + r.percentage, 0);
  if (Math.abs(total - 100) > 0.01) {
    return NextResponse.json({ error: `Percentages must sum to 100 (currently ${total.toFixed(3)})` }, { status: 400 });
  }

  const assign_value = assign_type === "vendor" ? norm(rawAssignValue) : rawAssignValue;
  const supabase = createServerClient();

  // 1. Delete only this version's rows (raw + normalized values for vendor)
  const deleteValues = assign_type === "vendor" && assign_value !== rawAssignValue
    ? [rawAssignValue, assign_value]
    : [assign_value];

  for (const dv of deleteValues) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let dq: any = supabase.from("cc_allocation_splits").delete()
      .eq("assign_type", assign_type)
      .eq("assign_value", dv);
    if (effective_from_year == null) {
      dq = dq.is("effective_from_year", null);
    } else {
      dq = dq.eq("effective_from_year", effective_from_year);
      if (effective_from_month == null) {
        dq = dq.is("effective_from_month", null);
      } else {
        dq = dq.eq("effective_from_month", effective_from_month);
      }
    }
    const { error: delErr } = await dq;
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });
  }

  // 2. Insert new rows for this version
  const { error: insErr } = await supabase.from("cc_allocation_splits").insert(
    splits.map((s) => ({
      assign_type,
      assign_value,
      cost_center_id:       s.cost_center_id,
      percentage:           s.percentage,
      is_operational:       s.is_operational ?? true,
      effective_from_year:  effective_from_year,
      effective_from_month: effective_from_month,
    }))
  );
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

  // 3. Load all versions for this key to determine which txs this version now covers
  const { data: allSplitRows } = await supabase
    .from("cc_allocation_splits")
    .select("assign_value,effective_from_year,effective_from_month,cost_center_id,percentage,is_operational")
    .eq("assign_type", assign_type)
    .eq("assign_value", assign_value);

  const allVersionsMap = buildVersionedSplitsMap(
    (allSplitRows ?? []).map((r) => ({
      assign_type,
      assign_value,
      cost_center_id:       r.cost_center_id as string,
      percentage:           r.percentage as number,
      is_operational:       ((r.is_operational ?? true) as boolean),
      effective_from_year:  (r.effective_from_year ?? null) as number | null,
      effective_from_month: (r.effective_from_month ?? null) as number | null,
    })) as SplitVersionRow[],
  );
  const keyVersions = allVersionsMap.get(`${assign_type}:${norm(assign_value)}`) ?? [];
  const newVersionPeriod = toPeriod(effective_from_year, effective_from_month);

  // Compute primary CC and operational_pct for the tx update
  const primaryCcId    = [...splits].sort((a, b) => b.percentage - a.percentage)[0].cost_center_id;
  const operationalPct = splits.reduce((s, r) => s + ((r.is_operational ?? true) ? r.percentage : 0), 0);

  // 4. Find split_propagated and unassigned txs — manual exceptions are never overwritten
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let txQ: any = supabase.from("pl_transactions").select("id,year,month");
  if (assign_type === "vendor") {
    const vendorLookup = assign_value !== rawAssignValue
      ? [rawAssignValue, assign_value]
      : [assign_value];
    txQ = txQ.in("vendor", vendorLookup);
  } else {
    txQ = txQ.eq("source", "offshore_allocations").eq("check_description_3", assign_value);
  }
  txQ = txQ.or("assignment_origin.eq.split_propagated,cost_center_status.eq.unassigned");

  const { data: txRows, error: txErr } = await txQ;
  if (txErr) return NextResponse.json({ error: txErr.message }, { status: 500 });

  // Only update txs whose applicable version matches the saved version
  const txIds: string[] = ((txRows ?? []) as Array<{ id: string; year: number | null; month: string | null }>)
    .filter((tx) => {
      const ver = findApplicableVersion(keyVersions, tx.year, tx.month);
      return ver !== null && ver.period === newVersionPeriod;
    })
    .map((tx) => tx.id);

  // 5. Update matching transactions and sync per-tx split rows
  if (txIds.length > 0) {
    for (let i = 0; i < txIds.length; i += CHUNK) {
      const { error: updErr } = await supabase
        .from("pl_transactions")
        .update({
          cost_center_id:        primaryCcId,
          cost_center_status:    "assigned",
          cost_center_conflicts: null,
          assignment_origin:     "split_propagated",
          operational_pct:       operationalPct,
        })
        .in("id", txIds.slice(i, i + CHUNK));
      if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    }

    for (let i = 0; i < txIds.length; i += CHUNK) {
      await supabase
        .from("cc_allocation_splits")
        .delete()
        .eq("assign_type", "transaction")
        .in("assign_value", txIds.slice(i, i + CHUNK));
    }
    const splitRows = txIds.flatMap((txId) =>
      splits.map((s) => ({
        assign_type:    "transaction" as const,
        assign_value:   txId,
        cost_center_id: s.cost_center_id,
        percentage:     s.percentage,
        is_operational: s.is_operational ?? true,
      }))
    );
    for (let i = 0; i < splitRows.length; i += CHUNK) {
      const { error: splErr } = await supabase
        .from("cc_allocation_splits")
        .insert(splitRows.slice(i, i + CHUNK));
      if (splErr) return NextResponse.json({ error: splErr.message }, { status: 500 });
    }
  }

  return NextResponse.json({ saved: splits.length, tx_updated: txIds.length });
}

/**
 * DELETE — two modes:
 *
 * A) Entire key (?type=X&value=Y): delete all versions + reset all split_propagated txs.
 *
 * B) Specific version (?type=X&value=Y&year=Z&month=W): delete that version and
 *    reassign the affected transactions to the predecessor version.
 *    Use year=0&month=0 to target the initial (NULL/NULL) version.
 *    Manual exceptions are never touched.
 */
export async function DELETE(req: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { searchParams } = new URL(req.url);
  const assign_type  = searchParams.get("type") as "vendor" | "description3" | null;
  const rawValue     = searchParams.get("value");
  const yearParam    = searchParams.get("year");
  const monthParam   = searchParams.get("month");

  if (!assign_type || !rawValue) {
    return NextResponse.json({ error: "type and value query params are required" }, { status: 400 });
  }

  const assign_value = assign_type === "vendor" ? norm(rawValue) : rawValue;
  const supabase = createServerClient();

  const isVersionDelete = yearParam !== null && monthParam !== null;

  // ── B. Specific-version delete ──────────────────────────────────────────────
  if (isVersionDelete) {
    const deletedYear   = Number(yearParam) === 0  ? null : Number(yearParam);
    const deletedMonth  = Number(monthParam) === 0 ? null : Number(monthParam);
    const deletedPeriod = toPeriod(deletedYear, deletedMonth);

    // Load all versions for this key
    const deleteValues = assign_type === "vendor" && assign_value !== rawValue
      ? [rawValue, assign_value]
      : [assign_value];

    const { data: allRows } = await supabase
      .from("cc_allocation_splits")
      .select("effective_from_year,effective_from_month,cost_center_id,percentage,is_operational")
      .eq("assign_type", assign_type)
      .in("assign_value", deleteValues);

    const allVersionsMap = buildVersionedSplitsMap(
      (allRows ?? []).map((r) => ({
        assign_type,
        assign_value,
        cost_center_id:       r.cost_center_id as string,
        percentage:           r.percentage as number,
        is_operational:       ((r.is_operational ?? true) as boolean),
        effective_from_year:  (r.effective_from_year ?? null) as number | null,
        effective_from_month: (r.effective_from_month ?? null) as number | null,
      })) as SplitVersionRow[],
    );
    const allVersionsSortedDesc = allVersionsMap.get(`${assign_type}:${norm(assign_value)}`) ?? [];
    const allVersionsAsc = [...allVersionsSortedDesc].reverse();

    const deletedIdx = allVersionsAsc.findIndex((v) => v.period === deletedPeriod);
    if (deletedIdx === -1) {
      return NextResponse.json({ error: "Version not found" }, { status: 404 });
    }

    const predecessor = deletedIdx > 0 ? allVersionsAsc[deletedIdx - 1] : null;
    const successor   = deletedIdx < allVersionsAsc.length - 1 ? allVersionsAsc[deletedIdx + 1] : null;

    // Fetch split_propagated txs for this key
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let txQ: any = supabase.from("pl_transactions").select("id,year,month");
    if (assign_type === "vendor") {
      txQ = txQ.in("vendor", deleteValues);
    } else {
      txQ = txQ.eq("source", "offshore_allocations").eq("check_description_3", assign_value);
    }
    txQ = txQ.eq("assignment_origin", "split_propagated");
    const { data: txRows, error: txErr } = await txQ;
    if (txErr) return NextResponse.json({ error: txErr.message }, { status: 500 });

    // Affected: txs in [deletedPeriod, successorPeriod)
    const affectedTxIds = ((txRows ?? []) as Array<{ id: string; year: number | null; month: string | null }>)
      .filter((tx) => {
        const p = txMonthPeriod(tx.year, tx.month);
        return p >= deletedPeriod && (successor == null || p < successor.period);
      })
      .map((tx) => tx.id);

    // Delete the version's split rows
    for (const dv of deleteValues) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let dq: any = supabase.from("cc_allocation_splits").delete()
        .eq("assign_type", assign_type).eq("assign_value", dv);
      if (deletedYear == null) {
        dq = dq.is("effective_from_year", null);
      } else {
        dq = dq.eq("effective_from_year", deletedYear);
        if (deletedMonth == null) {
          dq = dq.is("effective_from_month", null);
        } else {
          dq = dq.eq("effective_from_month", deletedMonth);
        }
      }
      const { error } = await dq;
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Reassign affected txs to predecessor (or reset to unassigned)
    if (affectedTxIds.length > 0) {
      if (predecessor) {
        const predSplits     = predecessor.splits;
        const primaryCcId    = [...predSplits].sort((a, b) => b.percentage - a.percentage)[0].cost_center_id;
        const operationalPct = predSplits.reduce((s, r) => s + (r.is_operational ? r.percentage : 0), 0);

        for (let i = 0; i < affectedTxIds.length; i += CHUNK) {
          await supabase.from("pl_transactions").update({
            cost_center_id:        primaryCcId,
            cost_center_status:    "assigned",
            cost_center_conflicts: null,
            assignment_origin:     "split_propagated",
            operational_pct:       operationalPct,
          }).in("id", affectedTxIds.slice(i, i + CHUNK));
        }
        for (let i = 0; i < affectedTxIds.length; i += CHUNK) {
          await supabase.from("cc_allocation_splits").delete()
            .eq("assign_type", "transaction")
            .in("assign_value", affectedTxIds.slice(i, i + CHUNK));
        }
        const predSplitRows = affectedTxIds.flatMap((txId) =>
          predSplits.map((s) => ({
            assign_type:    "transaction" as const,
            assign_value:   txId,
            cost_center_id: s.cost_center_id,
            percentage:     s.percentage,
            is_operational: s.is_operational,
          }))
        );
        for (let i = 0; i < predSplitRows.length; i += CHUNK) {
          await supabase.from("cc_allocation_splits").insert(predSplitRows.slice(i, i + CHUNK));
        }
      } else {
        // No predecessor — reset to unassigned
        for (let i = 0; i < affectedTxIds.length; i += CHUNK) {
          await supabase.from("pl_transactions").update({
            cost_center_id:        null,
            cost_center_status:    "unassigned",
            cost_center_conflicts: null,
            assignment_origin:     null,
            operational_pct:       100,
          }).in("id", affectedTxIds.slice(i, i + CHUNK));
        }
        for (let i = 0; i < affectedTxIds.length; i += CHUNK) {
          await supabase.from("cc_allocation_splits").delete()
            .eq("assign_type", "transaction")
            .in("assign_value", affectedTxIds.slice(i, i + CHUNK));
        }
      }
    }

    return NextResponse.json({ deleted: true, version: { year: deletedYear, month: deletedMonth }, tx_reassigned: affectedTxIds.length });
  }

  // ── A. Entire-key delete ─────────────────────────────────────────────────────
  const deleteValues = assign_type === "vendor" && assign_value !== rawValue
    ? [rawValue, assign_value]
    : [assign_value];

  for (const dv of deleteValues) {
    const { error: delErr } = await supabase
      .from("cc_allocation_splits")
      .delete()
      .eq("assign_type", assign_type)
      .eq("assign_value", dv);
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let txQ: any = supabase.from("pl_transactions").select("id");
  if (assign_type === "vendor") {
    txQ = txQ.in("vendor", deleteValues);
  } else {
    txQ = txQ.eq("source", "offshore_allocations").eq("check_description_3", assign_value);
  }
  txQ = txQ.eq("assignment_origin", "split_propagated");

  const { data: txRows, error: txErr } = await txQ;
  if (txErr) return NextResponse.json({ error: txErr.message }, { status: 500 });

  const txIds: string[] = (txRows ?? []).map((r: { id: string }) => r.id);

  if (txIds.length > 0) {
    for (let i = 0; i < txIds.length; i += CHUNK) {
      const { error: updErr } = await supabase
        .from("pl_transactions")
        .update({
          cost_center_id:        null,
          cost_center_status:    "unassigned",
          cost_center_conflicts: null,
          assignment_origin:     null,
          operational_pct:       100,
        })
        .in("id", txIds.slice(i, i + CHUNK));
      if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    }
  }

  return NextResponse.json({ deleted: true, tx_reset: txIds.length });
}
