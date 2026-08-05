export const MONTH_ORDER: Record<string, number> = {
  January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
  July: 7, August: 8, September: 9, October: 10, November: 11, December: 12,
};

export const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

export const MONTH_ABBR = [
  "Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec",
];

export type SplitVersionRow = {
  assign_type: string;
  assign_value: string;
  effective_from_year: number | null;
  effective_from_month: number | null;
  cost_center_id: string;
  percentage: number;
  is_operational: boolean;
};

export type SplitVersion = {
  year: number | null;
  month: number | null;
  period: number;
  splits: { cost_center_id: string; percentage: number; is_operational: boolean }[];
};

export type VersionedSplitsMap = Map<string, SplitVersion[]>;

export function toPeriod(year: number | null, month: number | null): number {
  if (year == null || month == null) return 0;
  return year * 100 + month;
}

export function txMonthPeriod(
  txYear: number | null | undefined,
  txMonth: string | null | undefined,
): number {
  if (txYear == null || txMonth == null) return 0;
  const m = MONTH_ORDER[txMonth];
  if (!m) return 0;
  return txYear * 100 + m;
}

export function findApplicableVersion(
  versions: SplitVersion[],
  txYear: number | null | undefined,
  txMonth: string | null | undefined,
): SplitVersion | null {
  if (versions.length === 0) return null;
  const p = txMonthPeriod(txYear, txMonth);
  return versions.find((v) => v.period <= p) ?? null;
}

function norm(v: string) {
  return v.trim().replace(/\s+/g, " ");
}

export function buildVersionedSplitsMap(rows: SplitVersionRow[]): VersionedSplitsMap {
  type PeriodKey = string;
  const perKey = new Map<string, Map<PeriodKey, SplitVersion>>();

  for (const row of rows) {
    const key = `${row.assign_type}:${norm(row.assign_value)}`;
    const period = toPeriod(row.effective_from_year, row.effective_from_month);
    const pkey = String(period);

    if (!perKey.has(key)) perKey.set(key, new Map());
    const vmap = perKey.get(key)!;
    if (!vmap.has(pkey)) {
      vmap.set(pkey, {
        year:   row.effective_from_year,
        month:  row.effective_from_month,
        period,
        splits: [],
      });
    }
    vmap.get(pkey)!.splits.push({
      cost_center_id: row.cost_center_id,
      percentage:     row.percentage,
      is_operational: row.is_operational,
    });
  }

  const result: VersionedSplitsMap = new Map();
  for (const [key, vmap] of perKey) {
    const versions = [...vmap.values()].sort((a, b) => b.period - a.period);
    result.set(key, versions);
  }
  return result;
}
