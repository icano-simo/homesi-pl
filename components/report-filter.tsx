"use client";

// ─── ReportFilter ──────────────────────────────────────────────────────────────
// Reusable multi-select dropdown for report filter bars (P&L All, CC Report, etc.)
// Standard for all financial pivot reports in this app.

import { useEffect, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";

interface ReportFilterProps {
  label: string;
  options: string[];
  selected: string[];
  onChange: (v: string[]) => void;
}

export function ReportFilter({ label, options, selected, onChange }: ReportFilterProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onOut(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onOut);
    return () => document.removeEventListener("mousedown", onOut);
  }, [open]);

  function toggle(v: string) {
    onChange(selected.includes(v) ? selected.filter(x => x !== v) : [...selected, v]);
  }

  const active = selected.length > 0;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={[
          "flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium whitespace-nowrap transition-colors",
          // Soft sky when a filter is applied, so an active constraint on the
          // figures is visible at a glance rather than only on inspection.
          active
            ? "border-sky-200 bg-sky-50 text-sky-900"
            : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50",
        ].join(" ")}
      >
        <span>{active ? `${label} (${selected.length})` : label}</span>
        {active && (
          <span
            role="button"
            onClick={e => { e.stopPropagation(); onChange([]); }}
            className="ml-0.5 hover:text-red-500"
          >
            <X size={11} />
          </span>
        )}
        <ChevronDown size={13} className={`ml-0.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-60 min-w-[160px] overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg">
          {options.length === 0 ? (
            <p className="px-3 py-2 text-xs text-gray-400">No options available</p>
          ) : (
            <>
              <div className="flex items-center justify-between border-b border-gray-100 px-3 py-1.5 sticky top-0 bg-white">
                <button
                  onClick={() => onChange(options)}
                  className="text-xs text-blue-600 hover:underline"
                >
                  Select all
                </button>
                <button
                  onClick={() => onChange([])}
                  className="text-xs text-gray-400 hover:text-gray-600 hover:underline"
                >
                  Deselect all
                </button>
              </div>
              {options.map(opt => (
                <label key={opt} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-50">
                  <input
                    type="checkbox"
                    checked={selected.includes(opt)}
                    onChange={() => toggle(opt)}
                    className="h-3.5 w-3.5 accent-blue-600 rounded border-gray-300"
                  />
                  <span className="truncate max-w-[220px] text-gray-700">{opt}</span>
                </label>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
