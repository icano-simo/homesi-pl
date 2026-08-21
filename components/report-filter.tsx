"use client";

// ─── ReportFilter ──────────────────────────────────────────────────────────────
// Reusable multi-select dropdown for report filter bars (P&L, Loan Count, etc.)
// Standard for all financial pivot reports in this app.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, X } from "lucide-react";

interface ReportFilterProps {
  label: string;
  options: string[];
  selected: string[];
  onChange: (v: string[]) => void;
}

const PANEL_W = 200;

export function ReportFilter({ label, options, selected, onChange }: ReportFilterProps) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  /**
   * Where the panel goes, measured from the button.
   *
   * The panel used to be `absolute top-full` inside this wrapper, which works
   * only while no ancestor clips it. Loan Count puts its Branch / LO / Channel
   * filters inside a `overflow-x-auto` bar, and a box that scrolls on one axis
   * clips on the other too — so the list opened underneath the bar and was cut
   * away entirely. The dropdowns looked empty, which read as "the filter has no
   * options" and sent three rounds of work at the filtering logic, which was
   * never wrong.
   *
   * Fixed and portalled to the body, so no ancestor can clip it. Same reason the
   * note preview in the pivot is portalled.
   */
  const place = useCallback(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setAt({
      top: r.bottom + 4,
      // Clamped: these bars scroll horizontally, so a filter can sit hard
      // against either edge of the window.
      left: Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - PANEL_W - 8)),
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      // The panel is no longer a descendant of the wrapper, so both have to be
      // checked or clicking a checkbox would close the list under the pointer.
      if (ref.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    }
    // Re-measure rather than close: the bar itself scrolls, and a list that
    // stayed behind while its button moved would point at the wrong filter.
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

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

      {open && at && typeof document !== "undefined" && createPortal(
        <div
          ref={panelRef}
          style={{ position: "fixed", top: at.top, left: at.left, width: PANEL_W, zIndex: 90 }}
          className="max-h-60 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg"
        >
          {options.length === 0 ? (
            <p className="px-3 py-2 text-xs text-gray-400">No options available</p>
          ) : (
            <>
              <div className="sticky top-0 flex items-center justify-between border-b border-gray-100 bg-white px-3 py-1.5">
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
                    className="h-3.5 w-3.5 shrink-0 rounded border-gray-300 accent-blue-600"
                  />
                  <span className="truncate text-gray-700">{opt}</span>
                </label>
              ))}
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
