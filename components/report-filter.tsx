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
  /**
   * Cuantas filas quedarian con cada opcion, del CONJUNTO COMPLETO.
   *
   * Sin esto, una lista larga es una lista de callejones sin salida: 55
   * programas de los que 50 ya no aplican se ven igual que los 5 que si.
   * `F30EEP (12)` y `C30 (0)` convierten la lista en informacion.
   *
   * ⚠ Del conjunto completo, NO de lo ya filtrado. Si los conteos --y las
   * opciones-- salieran de lo filtrado, elegir una cosa vaciaria los demas
   * desplegables y el usuario quedaria encerrado sin poder volver. Es la
   * decision que ya se tomo en Metrics B2B.
   */
  counts?: Record<string, number>;
  /** Caja de busqueda dentro del panel. Para listas de mas de ~15 valores. */
  searchable?: boolean;
}

const PANEL_W = 230;

export function ReportFilter({ label, options, selected, onChange, counts, searchable }: ReportFilterProps) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
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

  /** Lo que se pinta. La busqueda filtra la LISTA, nunca las opciones reales. */
  const shown = q.trim()
    ? options.filter((o) => o.toLowerCase().includes(q.trim().toLowerCase()))
    : options;

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
              <div className="sticky top-0 border-b border-gray-100 bg-white">
                <div className="flex items-center justify-between px-3 py-1.5">
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
                {searchable && (
                  <input
                    autoFocus
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search…"
                    className="mb-1.5 ml-3 w-[calc(100%-1.5rem)] rounded border border-gray-200 px-2 py-1 text-xs placeholder-gray-300 focus:outline-none focus:ring-1 focus:ring-blue-300"
                  />
                )}
              </div>
              {shown.length === 0 ? (
                <p className="px-3 py-2 text-xs text-gray-400">No match</p>
              ) : shown.map(opt => (
                <label key={opt} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-50">
                  <input
                    type="checkbox"
                    checked={selected.includes(opt)}
                    onChange={() => toggle(opt)}
                    className="h-3.5 w-3.5 shrink-0 rounded border-gray-300 accent-blue-600"
                  />
                  <span className="flex-1 truncate text-gray-700">{opt}</span>
                  {/* Un cero se atenua en vez de esconderse: que una opcion no
                      tenga filas es informacion, y quitarla de la lista la
                      volveria a convertir en un callejon invisible. */}
                  {counts && (
                    <span className={`shrink-0 font-mono text-[10px] ${counts[opt] ? "text-gray-400" : "text-gray-300"}`}>
                      {counts[opt] ?? 0}
                    </span>
                  )}
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
