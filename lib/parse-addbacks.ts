import { readSheetRaw } from "@/lib/excel-utils";
import { MONTH_NAMES } from "@/lib/constants";
import type { NormalizedRow, NormalizeWarning } from "@/types";

type ColKey = "glCode" | "branch" | "glName" | "checkDescription" | "debit" | "credit" | "month" | "year";

const HEADER_ALIASES: Record<ColKey, string[]> = {
  glCode:           ["gl code", "glcode", "gl_code"],
  branch:           ["branch"],
  glName:           ["gl name", "glname", "gl_name"],
  checkDescription: ["check description", "checkdescription", "check_description", "description"],
  debit:            ["debit"],
  credit:           ["credit"],
  month:            ["month"],
  year:             ["year"],
};

const REQUIRED: ColKey[] = ["glCode", "branch", "debit", "credit", "month", "year"];

function normalizeHeader(v: unknown): string {
  return String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeMonth(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = parseInt(s, 10);
  if (!isNaN(n) && n >= 1 && n <= 12) return MONTH_NAMES[n - 1];
  const lower = s.toLowerCase().slice(0, 3);
  return MONTH_NAMES.find(m => m.toLowerCase().startsWith(lower)) ?? null;
}

function toNum(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/,/g, ""));
  return isNaN(n) ? 0 : n;
}

export function parseAddbacks(
  buffer: Buffer
): { rows: NormalizedRow[]; warnings: NormalizeWarning[] } {
  const { rows: raw } = readSheetRaw(buffer, () => true);
  const rows: NormalizedRow[] = [];
  const warnings: NormalizeWarning[] = [];

  // ── Find header row ──────────────────────────────────────────────────────────
  let headerRowIdx = -1;
  let colIdx: Partial<Record<ColKey, number>> = {};

  for (let i = 0; i < raw.length; i++) {
    const candidate: Partial<Record<ColKey, number>> = {};
    for (let c = 0; c < raw[i].length; c++) {
      const h = normalizeHeader(raw[i][c]);
      for (const [key, aliases] of Object.entries(HEADER_ALIASES) as [ColKey, string[]][]) {
        if (colIdx[key as ColKey] === undefined && aliases.some(a => h === a || h.includes(a))) {
          candidate[key as ColKey] = c;
        }
      }
    }
    if (REQUIRED.every(k => candidate[k] !== undefined)) {
      headerRowIdx = i;
      colIdx = candidate;
      break;
    }
  }

  if (headerRowIdx === -1) {
    warnings.push({
      rowIndex: 0,
      rawGLNumber: "",
      message:
        "Could not find header row. Required columns: GL Code, Branch, Debit, Credit, Month, Year.",
    });
    return { rows, warnings };
  }

  const col = colIdx as Record<ColKey, number>;

  // ── Parse data rows ──────────────────────────────────────────────────────────
  for (let i = headerRowIdx + 1; i < raw.length; i++) {
    const row = raw[i];
    if (!row || row.every(c => c == null || String(c).trim() === "")) continue;

    const glCode = String(row[col.glCode] ?? "").trim();
    const branch = String(row[col.branch] ?? "").trim();

    if (!glCode && !branch) continue;

    if (!glCode) {
      warnings.push({ rowIndex: i + 1, rawGLNumber: "", message: "Missing GL Code — row skipped" });
      continue;
    }

    const month = normalizeMonth(row[col.month]);
    if (!month) {
      warnings.push({
        rowIndex: i + 1,
        rawGLNumber: glCode,
        message: `Unrecognized month value: "${row[col.month]}" — row skipped`,
      });
      continue;
    }

    const yearRaw = parseInt(String(row[col.year] ?? ""), 10);
    const glName = col.glName !== undefined ? String(row[col.glName] ?? "").trim() : "";
    const checkDesc =
      col.checkDescription !== undefined ? String(row[col.checkDescription] ?? "").trim() : "";
    const debit = toNum(row[col.debit]);
    const credit = toNum(row[col.credit]);

    rows.push({
      gl_number_raw: glCode,
      gl_code: glCode,
      branch,
      gl_name: glName,
      check_description: checkDesc,
      loan_number: null,
      loan_number_raw: null,
      borrower_name: null,
      journal_post_date: null,
      year: isNaN(yearRaw) ? null : yearRaw,
      month,
      vendor: "",
      invoice_numb: "",
      ref_numb: "",
      doc_type: "",
      debit,
      credit,
      movement: credit - debit,
    });
  }

  return { rows, warnings };
}
