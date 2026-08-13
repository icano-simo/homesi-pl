"use client";

const MONTH_ORDER = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

const MONTH_SHORT: Record<string, string> = {
  January: "Jan", February: "Feb", March: "Mar", April: "Apr",
  May: "May", June: "Jun", July: "Jul", August: "Aug",
  September: "Sep", October: "Oct", November: "Nov", December: "Dec",
};

export interface MonthMetrics {
  total: number; banked: number; brokered: number; other: number;
  amount_total: number; amount_banked: number; amount_brokered: number; amount_other: number;
  b2b: number; processing: number; support_on_demand: number; affinity: number; recruitment: number;
}

export type BpsBase = "all" | "banked" | "brokered";

export const BPS_BASE_LABELS: Record<BpsBase, string> = {
  all:      "All channels",
  banked:   "Banked only",
  brokered: "Brokered only",
};

export interface LoanMetricsData {
  by_month: Record<string, MonthMetrics>;
  bps_base_by_month: Record<string, { all: number; banked: number; brokered: number }>;
  base_is_division_wide: boolean;
  unmatched_branches: string[];
  excluded_loans: number;
  bucket_drift_months: string[];
}

interface Props {
  data: LoanMetricsData | null;
  loading: boolean;
  error: string;
  /** Whether the cards show loan counts or loan amounts. */
  mode: "count" | "amount";
  onModeChange: (m: "count" | "amount") => void;
  /** bps annotation on the P&L grid. Only meaningful with mode="amount". */
  showBps: boolean;
  onShowBpsChange: (v: boolean) => void;
  bpsBase: BpsBase;
  onBpsBaseChange: (b: BpsBase) => void;
  /** Opens the per-loan detail for a month. Omit to leave the totals inert. */
  onOpenMonth?: (month: string) => void;
}

const fmtCount = (n: number) => n.toLocaleString("en-US");
const fmtMoney = (n: number) =>
  `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

export function LoanMetricsByMonthBar({
  data, loading, error, mode, onModeChange, showBps, onShowBpsChange, bpsBase, onBpsBaseChange,
  onOpenMonth,
}: Props) {
  if (loading) {
    return <div className="mb-6 h-[186px] animate-pulse rounded-2xl border border-slate-200/80 bg-slate-50" />;
  }

  if (error) {
    return (
      <p className="mb-6 rounded-2xl border border-red-100 bg-red-50 px-4 py-2 text-xs text-red-600">
        Loan metrics: {error}
      </p>
    );
  }

  const byMonth = data?.by_month ?? {};
  const months = Object.keys(byMonth)
    .filter((m) => (byMonth[m]?.total ?? 0) > 0)
    .sort((a, b) => MONTH_ORDER.indexOf(a) - MONTH_ORDER.indexOf(b));

  const unmatched = data?.unmatched_branches ?? [];
  // Nothing to show, but a branch filter with no loan counterpart still has to
  // explain itself — otherwise an empty panel reads as a loading failure.
  if (months.length === 0 && unmatched.length === 0) return null;

  return (
    <div className="mb-6 rounded-2xl border border-slate-200/80 bg-white p-4 shadow-xs">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span className="text-xs font-bold uppercase tracking-wider text-[#001A40]">
          Loan {mode === "count" ? "Count" : "Amount"} by Month
        </span>

        <Segmented
          options={[{ v: "count", label: "Loan count" }, { v: "amount", label: "Loan amount" }]}
          value={mode}
          onChange={(v) => onModeChange(v as "count" | "amount")}
        />

        {mode === "amount" && (
          <>
            <button
              onClick={() => onShowBpsChange(!showBps)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                showBps
                  ? "border-sky-200 bg-sky-50 text-sky-900"
                  : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50"
              }`}
            >
              {showBps ? "Hide bps" : "Show bps"}
            </button>

            {showBps && (
              <Segmented
                options={(Object.keys(BPS_BASE_LABELS) as BpsBase[]).map((b) => ({
                  v: b, label: BPS_BASE_LABELS[b],
                }))}
                value={bpsBase}
                onChange={(v) => onBpsBaseChange(v as BpsBase)}
              />
            )}
          </>
        )}
      </div>

      {/* The formula, spelled out. A reader has to be able to tell 100 bps over
          banked volume from 100 bps over total volume, and the two look
          identical on the page. */}
      {mode === "amount" && showBps && (
        <p className="mb-3 text-[11px] text-slate-500">
          bps = figure ÷ <span className="font-semibold text-[#001A40]">
            {BPS_BASE_LABELS[bpsBase]}
          </span> loan volume × 10,000
          {data?.base_is_division_wide && (
            <span className="ml-1.5 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
              division-wide volume (corporate branch 700)
            </span>
          )}
        </p>
      )}

      {unmatched.length > 0 && (
        <p className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-medium text-amber-900">
          No loan volume for branch{unmatched.length > 1 ? "es" : ""}: {unmatched.join(", ")}.
          {" "}These branches have P&amp;L activity but no loans in the master list, so their
          bps cannot be computed.
        </p>
      )}

      {data && data.bucket_drift_months.length > 0 && (
        <p className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[11px] font-medium text-red-800">
          Channel breakdown does not reconcile with the total in:{" "}
          {data.bucket_drift_months.join(", ")}. Treat the split as unreliable.
        </p>
      )}

      {months.length > 0 && (
        <div className="scrollbar-thin-slate flex snap-x items-stretch gap-3 overflow-x-auto pb-2">
          {months.map((month) => (
            <MonthCard key={month} month={month} m={byMonth[month]} mode={mode} onOpen={onOpenMonth} />
          ))}
        </div>
      )}
    </div>
  );
}

function Segmented({ options, value, onChange }: {
  options: { v: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="inline-flex rounded-full border border-slate-200 bg-white p-0.5">
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
            value === o.v
              ? "bg-[#A6DEFF]/30 text-[#001A40] font-semibold"
              : "text-slate-500 hover:text-[#001A40]"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function MonthCard({ month, m, mode, onOpen }: {
  month: string; m: MonthMetrics; mode: "count" | "amount"; onOpen?: (month: string) => void;
}) {
  const hasTags = m.b2b + m.processing + m.support_on_demand + m.affinity + m.recruitment > 0;
  const isAmount = mode === "amount";

  const hero      = isAmount ? fmtMoney(m.amount_total)    : fmtCount(m.total);
  const banked    = isAmount ? fmtMoney(m.amount_banked)   : fmtCount(m.banked);
  const brokered  = isAmount ? fmtMoney(m.amount_brokered) : fmtCount(m.brokered);
  const other     = isAmount ? fmtMoney(m.amount_other)    : fmtCount(m.other);
  const showOther = isAmount ? m.amount_other > 0 : m.other > 0;

  return (
    // shrink-0 is what makes the strip work: without it flex would compress
    // every card to fit the container, squashing the pills onto separate lines.
    // Amounts need more room than counts, hence the wider card in that mode.
    <div className={`flex ${isAmount ? "w-[212px]" : "w-[168px]"} shrink-0 snap-start flex-col justify-between rounded-xl border border-slate-200/60 bg-slate-50/60 p-3 transition-all hover:border-[#A6DEFF] hover:bg-white hover:shadow-xs`}>
      <div className="mb-1 text-xs font-bold uppercase tracking-wider text-slate-400">
        {MONTH_SHORT[month] ?? month}
      </div>

      <div className="flex items-baseline">
        {/* The total is the way into the loans behind it, in either mode. */}
        <button
          type="button"
          disabled={!onOpen}
          onClick={() => onOpen?.(month)}
          title={onOpen ? `Show the ${m.total} loans behind ${month}` : undefined}
          className={`font-bold tabular-nums text-[#001A40] ${isAmount ? "text-lg" : "text-2xl"} ${
            onOpen ? "cursor-pointer rounded underline decoration-[#A6DEFF] decoration-2 underline-offset-4 hover:decoration-[#001A40]" : ""
          }`}
        >
          {hero}
        </button>
        <span className="ml-1.5 text-xs font-medium text-slate-500">total</span>
      </div>

      <div className="mb-2 text-[11px] font-semibold text-slate-600">
        <span className="tabular-nums">{banked}</span> B
        <span className="mx-1 text-slate-300">·</span>
        <span className="tabular-nums">{brokered}</span> Br
        {showOther && (
          <>
            <span className="mx-1 text-slate-300">·</span>
            <span className="tabular-nums">{other}</span> Other
          </>
        )}
      </div>

      {hasTags && (
        <div className="mt-1 flex flex-wrap gap-1">
          {m.b2b > 0               && <MiniTag label="B2B"  v={m.b2b} />}
          {m.processing > 0        && <MiniTag label="Proc" v={m.processing} />}
          {m.support_on_demand > 0 && <MiniTag label="OD"   v={m.support_on_demand} />}
          {m.affinity > 0          && <MiniTag label="Aff"  v={m.affinity} />}
          {m.recruitment > 0       && <MiniTag label="Rec"  v={m.recruitment} />}
        </div>
      )}
    </div>
  );
}

function MiniTag({ label, v }: { label: string; v: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-[#A6DEFF]/40 bg-[#A6DEFF]/25 px-2 py-0.5 text-[10px] font-bold text-[#001A40]">
      <span className="tabular-nums">{v}</span>
      {label}
    </span>
  );
}
