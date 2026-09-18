"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Search, RefreshCw, Download } from "lucide-react";
import { downloadCSV } from "@/lib/csv";
import { ReportFilter } from "@/components/report-filter";
import { useActiveBranches, mergeWithGlobal } from "@/components/branch-filter-provider";
import type { RosterPerson, RosterResult } from "@/app/api/roster/route";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ROSTER -- QUIEN TRABAJA AQUI, DONDE Y CON QUE CARGO
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ SIN IMPORTES, Y NO ES UN OLVIDO. El coste de estas personas vive en el P&L
 * con sus centros de coste, sus notas y sus splits, y esta pantalla no los toca
 * ni los repite. Poner aqui una cifra crearia un segundo sitio donde mirar lo
 * mismo, que es como dos totales dejan de cuadrar.
 *
 * ⚠ UNA FILA POR PERSONA, TAMBIEN AL FILTRAR. Al acotar una sucursal se recorta
 * la columna de sucursales; nadie se parte en dos filas. De las 139 personas,
 * 23 sirven a mas de una sucursal: con el grano persona-sucursal saldrian dos y
 * tres veces con el mismo contenido, y el conteo de filas cambiaria segun el
 * filtro.
 */
export default function RosterPage() {
  const { activeBranches } = useActiveBranches();
  const [data, setData] = useState<RosterResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filterBranches, setFilterBranches] = useState<string[]>([]);

  const cargar = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const qs = new URLSearchParams();
      for (const b of mergeWithGlobal(filterBranches, activeBranches)) qs.append("branch", b);
      const r = await fetch(`/api/roster?${qs}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "No se pudo cargar el roster");
      setData(j as RosterResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [filterBranches, activeBranches]);

  useEffect(() => { void cargar(); }, [cargar]);

  const visibles = useMemo(() => {
    const people = data?.people ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return people;
    return people.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.position ?? "").toLowerCase().includes(q) ||
        p.branches.some((b) => b.toLowerCase().includes(q)),
    );
  }, [data, query]);

  const exportar = () =>
    downloadCSV(
      "roster.csv",
      visibles.map((p) => ({
        name: p.name,
        branches: p.branches.join(" · "),
        position: p.position ?? (p.positionAmbiguous ? p.positionRaw.join(" | ") : ""),
        source: p.positionSource ?? "",
        position_in_file: p.positionInFile ?? "",
        in_hr_roster: p.inRoster ? "yes" : "no",
        in_offshore_file: p.inFile ? "yes" : "no",
      })),
      [
        { key: "name", label: "Name" },
        { key: "branches", label: "Branch" },
        { key: "position", label: "Position" },
        { key: "source", label: "Source" },
        { key: "position_in_file", label: "Position in file" },
        { key: "in_hr_roster", label: "In HR roster" },
        { key: "in_offshore_file", label: "In offshore file" },
      ],
    );

  return (
    <div className="p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-[#001A40]">Roster</h1>
          <p className="text-xs text-slate-500">
            People, their branch and their position. No amounts — the cost lives in the P&amp;L.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void cargar()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-[#001A40]"
          >
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
          <button
            onClick={exportar}
            disabled={visibles.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-[#001A40] disabled:opacity-40"
          >
            <Download size={13} /> CSV
          </button>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ReportFilter
          label="Branch"
          options={data?.branches ?? []}
          selected={filterBranches}
          onChange={setFilterBranches}
          searchable
        />
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name, position or branch"
            className="w-64 rounded-lg border border-slate-200 bg-white py-1.5 pl-8 pr-3 text-xs text-slate-700 placeholder:text-slate-400 focus:border-[#001A40] focus:outline-none"
          />
        </div>
        {/* ⚠ El conteo dice PERSONAS porque la fila es la persona. Si dijera
            "filas" y el grano cambiara al filtrar, seria la misma palabra para
            dos cosas distintas. */}
        <span className="text-xs text-slate-500">
          {loading ? "Loading…" : `${visibles.length} ${visibles.length === 1 ? "person" : "people"}`}
          {data && !loading && visibles.length === data.counts.total && (
            <span className="text-slate-400">
              {" "}· {data.counts.inBoth} in both sources · {data.counts.onlyRoster} HR only ·{" "}
              {data.counts.onlyFile} offshore file only
            </span>
          )}
        </span>
      </div>

      {data?.notes.map((n) => (
        <p key={n} className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
          {n}
        </p>
      ))}
      {error && (
        <p className="mb-2 rounded-lg border border-[#FF4040]/30 bg-[#FF4040]/5 px-3 py-1.5 text-xs text-[#FF4040]">
          {error}
        </p>
      )}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 bg-slate-100/90">
            <tr className="border-b-2 border-slate-200 text-left text-[10px] uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2 font-semibold">Name</th>
              <th className="px-3 py-2 font-semibold">Branch</th>
              <th className="px-3 py-2 font-semibold">Position</th>
              <th className="px-3 py-2 font-semibold">Source</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-slate-400">Loading…</td></tr>
            )}
            {!loading && visibles.length === 0 && (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-slate-400">No one matches.</td></tr>
            )}
            {!loading && visibles.map((p) => <Fila key={p.key} p={p} />)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Fila({ p }: { p: RosterPerson }) {
  return (
    <tr className="border-b border-slate-200/50 hover:bg-[#A6DEFF]/15">
      <td className="px-3 py-1.5 text-slate-700">{p.name}</td>
      <td className="px-3 py-1.5">
        <span className="flex flex-wrap gap-1">
          {p.branches.length === 0 ? (
            /* ⚠ AUSENCIA, NO CERO: que no conste no es que no tenga. */
            <span className="text-slate-400" title="No branch in either source.">not on record</span>
          ) : (
            p.branches.map((b) => (
              <span key={b} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600">
                {b}
              </span>
            ))
          )}
        </span>
      </td>
      <td className="px-3 py-1.5">
        {p.position ? (
          <span className="text-slate-700">{p.position}</span>
        ) : p.positionAmbiguous ? (
          /* Dos valores y ninguna regla los separa. Se enseñan crudos y
             marcados: acertar por casualidad seria peor que decirlo. */
          <span
            className="text-amber-700"
            title="The file gives more than one position for this person and none of them is more specific than the other. Shown raw, unresolved."
          >
            {p.positionRaw.join(" | ")}{" "}
            <span className="text-[10px] uppercase tracking-wide text-amber-600">· unresolved</span>
          </span>
        ) : (
          <span className="text-slate-400" title="Neither the HR roster nor the file gives a position.">
            not on record
          </span>
        )}
      </td>
      <td className="px-3 py-1.5">
        {p.positionSource === "roster" ? (
          <span className="text-slate-500" title="From the HR roster, which wins when the person is in it.">
            HR roster
          </span>
        ) : p.positionSource === "file" ? (
          <span className="text-slate-500" title="From the offshore file. This person is not in the HR roster.">
            offshore file
          </span>
        ) : (
          <span className="text-slate-300">—</span>
        )}
        {/* ⚠ SIN ETIQUETA DE ASCENSO. En 31 de las 45 personas que estan en las
            dos fuentes los dos cargos difieren, y al mirarlas NO son cambios de
            puesto: es vocabulario sucio, un cubo de coste contra un cargo. */}
        {p.positionSource === "roster" && p.positionInFile && (
          <span className="ml-1 text-slate-300" title={`The file says "${p.positionInFile}" for this person. The two vocabularies differ; this is not a record of a promotion.`}>
            · file: {p.positionInFile}
          </span>
        )}
      </td>
    </tr>
  );
}
