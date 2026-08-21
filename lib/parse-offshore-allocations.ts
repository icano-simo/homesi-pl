import { readSheetRaw } from "@/lib/excel-utils";
import { MONTH_NAMES } from "@/lib/constants";
import type { NormalizeWarning } from "@/types";

type ColKey =
  | "glCode"
  | "branch"
  | "glName"
  | "checkDescription"
  | "checkDescription2"
  | "checkDescription3"
  | "movement"
  | "year"
  | "month"
  | "vendor"
  | "category"
  | "position"
  | "branchAllocation";

export interface OffshoreRow {
  gl_number_raw: string;
  gl_code: string;
  branch: string;
  gl_name: string;
  check_description: string;
  check_description_2: string | null;
  check_description_3: string | null;
  year: number | null;
  month: string | null;
  vendor: string;
  category: string | null;
  position: string | null;
  branch_allocation: string | null;
  debit: number;
  credit: number;
  movement: number;
  loan_number: null;
  borrower_name: null;
  journal_post_date: null;
  invoice_numb: string;
  ref_numb: string;
  doc_type: string;
}

const HEADER_ALIASES: Record<ColKey, string[]> = {
  glCode:            ["gl code", "glcode", "gl_code"],
  branch:            ["branch"],
  glName:            ["gl name", "glname", "gl_name"],
  checkDescription:  ["check description", "checkdescription", "check_description", "description"],
  checkDescription2: ["check description 2", "checkdescription2", "check_description_2"],
  checkDescription3: ["check description 3", "checkdescription3", "check_description_3"],
  movement:          ["movement", "payroll", "total pay", "amount"],
  year:              ["year"],
  month:             ["month"],
  vendor:            ["vendor"],
  category:          ["category"],
  position:          ["position"],
  branchAllocation:  ["branch allocation", "branchallocation", "branch_allocation"],
};

const REQUIRED: ColKey[] = ["glCode", "branch", "movement", "month", "year"];

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
  return MONTH_NAMES.find((m) => m.toLowerCase().startsWith(lower)) ?? null;
}

function toNum(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/,/g, ""));
  return isNaN(n) ? 0 : n;
}

function toStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

export function parseOffshoreAllocations(
  buffer: Buffer
): { rows: OffshoreRow[]; warnings: NormalizeWarning[] } {
  const { rows: raw } = readSheetRaw(buffer, () => true);
  const rows: OffshoreRow[] = [];
  const warnings: NormalizeWarning[] = [];

  // ── Find header row ──────────────────────────────────────────────────────────
  let headerRowIdx = -1;
  let colIdx: Partial<Record<ColKey, number>> = {};

  for (let i = 0; i < raw.length; i++) {
    const candidate: Partial<Record<ColKey, number>> = {};
    for (let c = 0; c < raw[i].length; c++) {
      const h = normalizeHeader(raw[i][c]);
      for (const [key, aliases] of Object.entries(HEADER_ALIASES) as [ColKey, string[]][]) {
        if (candidate[key] === undefined && aliases.some((a) => h === a || h.includes(a))) {
          candidate[key] = c;
        }
      }
    }
    if (REQUIRED.every((k) => candidate[k] !== undefined)) {
      headerRowIdx = i;
      colIdx = candidate;
      break;
    }
  }

  if (headerRowIdx === -1) {
    warnings.push({
      rowIndex: 0,
      rawGLNumber: "",
      message: "Could not find header row. Required columns: GL Code, Branch, Movement, Month, Year.",
    });
    return { rows, warnings };
  }

  const col = colIdx as Record<ColKey, number | undefined>;

  // ── Parse data rows ──────────────────────────────────────────────────────────
  for (let i = headerRowIdx + 1; i < raw.length; i++) {
    const row = raw[i];
    if (!row || row.every((c) => c == null || String(c).trim() === "")) continue;

    const glCode = String(row[col.glCode!] ?? "").trim();
    const branch = String(row[col.branch!] ?? "").trim();
    if (!glCode && !branch) continue;

    if (!glCode) {
      warnings.push({ rowIndex: i + 1, rawGLNumber: "", message: "Missing GL Code — row skipped" });
      continue;
    }

    const month = normalizeMonth(col.month !== undefined ? row[col.month] : null);
    if (!month) {
      warnings.push({
        rowIndex: i + 1,
        rawGLNumber: glCode,
        message: `Unrecognized month value: "${col.month !== undefined ? row[col.month] : ""}" — row skipped`,
      });
      continue;
    }

    const rawMovement = toNum(col.movement !== undefined ? row[col.movement] : 0);
    const yearRaw = parseInt(String(col.year !== undefined ? (row[col.year!] ?? "") : ""), 10);

    rows.push({
      gl_number_raw:       glCode,
      gl_code:             glCode,
      branch,
      gl_name:             col.glName !== undefined ? String(row[col.glName] ?? "").trim() : "",
      check_description:   col.checkDescription !== undefined ? String(row[col.checkDescription] ?? "").trim() : "",
      check_description_2: col.checkDescription2 !== undefined ? toStr(row[col.checkDescription2]) : null,
      check_description_3: col.checkDescription3 !== undefined ? toStr(row[col.checkDescription3]) : null,
      year:                isNaN(yearRaw) ? null : yearRaw,
      month,
      vendor:              col.vendor !== undefined ? String(row[col.vendor] ?? "").trim() : "",
      category:            col.category !== undefined ? toStr(row[col.category]) : null,
      position:            col.position !== undefined ? toStr(row[col.position]) : null,
      branch_allocation:   col.branchAllocation !== undefined ? toStr(row[col.branchAllocation]) : null,
      // sign transformation: debit = raw movement, credit = 0, stored movement = -raw movement
      debit:    rawMovement,
      credit:   0,
      movement: -rawMovement,
      // standard filler fields
      loan_number:       null,
      borrower_name:     null,
      journal_post_date: null,
      invoice_numb:      "",
      ref_numb:          "",
      doc_type:          "",
    });
  }

  return { rows, warnings };
}
