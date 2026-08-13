"use client";

import { useEffect, useMemo, useState } from "react";
import type { BpsBase, LoanMetricsData } from "@/components/loan-metrics-by-month";
import { BPS_BASE_LABELS } from "@/components/loan-metrics-by-month";

/**
 * Loan metrics for a report, plus the state of the three controls that use them.
 *
 * The fetch lives here rather than inside LoanMetricsByMonthBar because two
 * consumers need the same numbers: the strip draws the counts and amounts, and
 * the pivot divides its figures by the same monthly volumes to get basis
 * points. One request, one row set, one set of numbers — the requirement that
 * the amount be the sum of exactly the loans the count counts cannot be met if
 * the two are fetched separately.
 */
export function useLoanMetrics(
  years: string[],
  branches: string[],
  sources: string[],
  costCenterIds?: string[],
) {
  const [data, setData]       = useState<LoanMetricsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState("");

  const [mode, setMode]       = useState<"count" | "amount">("count");
  const [showBps, setShowBps] = useState(false);
  // Banked by default: it is the volume the division is actually paid on.
  const [bpsBase, setBpsBase] = useState<BpsBase>("banked");

  const key = [years, branches, sources, costCenterIds ?? []].map((a) => a.join(",")).join("|");

  useEffect(() => {
    if (years.length === 0) { setData(null); return; }

    const p = new URLSearchParams({ group_by: "month" });
    years.forEach((y) => p.append("year", y));
    branches.forEach((b) => p.append("branch", b));
    sources.forEach((s) => p.append("source", s));
    (costCenterIds ?? []).forEach((id) => p.append("cost_center_id", id));

    let cancelled = false;
    setLoading(true);
    setError("");
    fetch(`/api/loan-metrics?${p}`)
      .then(async (r) => {
        const d = await r.json();
        if (cancelled) return;
        if (!r.ok) { setError(d?.error ?? "Error loading loan metrics"); setData(null); return; }
        setData(d as LoanMetricsData);
      })
      .catch((e) => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  /**
   * Monthly denominators, or null when the annotation is off.
   *
   * Null rather than an empty object: the pivot treats null as "do not draw a
   * bps line at all", while an empty object would draw a dash on every cell and
   * suggest the numbers failed to load.
   */
  const bpsBaseByMonth = useMemo<Record<string, number> | null>(() => {
    if (mode !== "amount" || !showBps || !data) return null;
    const out: Record<string, number> = {};
    for (const [month, b] of Object.entries(data.bps_base_by_month)) out[month] = b[bpsBase];
    return out;
  }, [mode, showBps, bpsBase, data]);

  const bpsBaseLabel = bpsBaseByMonth
    ? `${BPS_BASE_LABELS[bpsBase]}${data?.base_is_division_wide ? " · all branches" : ""}`
    : null;

  return {
    data, loading, error,
    mode, setMode,
    showBps, setShowBps,
    bpsBase, setBpsBase,
    bpsBaseByMonth, bpsBaseLabel,
  };
}
