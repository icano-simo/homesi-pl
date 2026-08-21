import { readSheetRaw } from "@/lib/excel-utils";
import {
  GL_COL,
  GL_NUMBER_SEPARATOR,
  GL_SHEET_IDENTIFIER,
  MONTH_NAMES,
  TOTAL_FILTER_KEYWORD,
} from "@/lib/constants";
import type { NormalizePLResult, NormalizedRow, NormalizeWarning } from "@/types";

// ─── Utilities ────────────────────────────────────────────────────────────────

function trimStr(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function toNum(v: unknown): number {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function parseExcelDate(value: unknown): Date | null {
  if (!value && value !== 0) return null;
  // Excel serial number (most common case with raw: true)
  if (typeof value === "number") {
    return new Date(Math.round((value - 25569) * 86400 * 1000));
  }
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// ─── Loan number extraction ───────────────────────────────────────────────────

export function extractLoanNumber(desc: string): string | null {
  // Prefer 12-digit standalone number, then 11, 10, 9 (all resolved later by completion)
  const m12 = desc.match(/(?<!\d)\d{12}(?!\d)/);
  if (m12) return m12[0];
  const m11 = desc.match(/(?<!\d)\d{11}(?!\d)/);
  if (m11) return m11[0];
  const m10 = desc.match(/(?<!\d)\d{10}(?!\d)/);
  if (m10) return m10[0];
  const m9 = desc.match(/(?<!\d)\d{9}(?!\d)/);
  if (m9) return m9[0];
  return null;
}

// ─── Main parser ──────────────────────────────────────────────────────────────

/**
 * Normalizes a raw GL Detail Report Excel buffer into typed transaction rows.
 * Rows that throw during parsing are collected as warnings (not propagated),
 * so a single bad row never aborts the entire upload.
 *
 * Steps applied in this exact order (per spec):
 * 1. Promote headers from row 0
 * 2. Filter rows where CheckDescription contains "total" (BEFORE fill-down)
 * 3. Fill-down GLNumber and GLName
 * 4. Split GLNumber → gl_code + branch
 * 5. CheckDescription as-is; loan_number/borrower_name = null
 * 6. Vendor as-is
 * 7. Parse JournalPostDate
 * 8. Derive Year, Month, Movement = Credit − Debit
 * 9. Trim text fields
 */
export function normalizePL(buffer: Buffer): NormalizePLResult {
  const { rows: raw, sheet } = readSheetRaw(
    buffer,
    (name) => name.toLowerCase().includes(GL_SHEET_IDENTIFIER)
  );

  // ── Step 1: promote headers ──────────────────────────────────────────────
  const headers = raw.length > 0 ? (raw[0] as unknown[]).map(trimStr) : [];

  /**
   * Columns without which nothing can be read.
   *
   * `col()` below answers `undefined` for a header it cannot find, and every
   * step downstream treats that as an empty value: no GL code, no branch, no
   * date and therefore no period, and a movement of zero. The row count comes
   * out right, so the upload used to finish as "completed" having imported
   * nothing at all. It has happened twice — 13.848 rows on 27 July and again
   * this month — so the absence is reported instead of tolerated.
   */
  const REQUIRED = [
    GL_COL.GL_NUMBER, GL_COL.CHECK_DESCRIPTION,
    GL_COL.JOURNAL_POST_DATE, GL_COL.DEBIT, GL_COL.CREDIT,
  ] as const;
  const missingColumns = REQUIRED.filter((c) => !headers.includes(c));

  if (raw.length < 2) return { rows: [], warnings: [], sheet, headers, missingColumns };

  const dataRows = raw.slice(1) as unknown[][];

  function col(row: unknown[], key: string): unknown {
    const idx = headers.indexOf(key);
    return idx >= 0 ? row[idx] : undefined;
  }

  // ── Step 2: filter subtotal / summary rows (before fill-down) ───────────
  const filtered = dataRows.filter((row) => {
    const desc = trimStr(col(row, GL_COL.CHECK_DESCRIPTION));
    return !desc.toLowerCase().includes(TOTAL_FILTER_KEYWORD);
  });

  // ── Step 3: fill-down GLNumber and GLName ────────────────────────────────
  let lastGLNumber = "";
  let lastGLName = "";

  const filled: Array<{ row: unknown[]; glNumber: string; glName: string }> =
    filtered.map((row) => {
      const rawNum = trimStr(col(row, GL_COL.GL_NUMBER));
      const rawName = trimStr(col(row, GL_COL.GL_NAME));
      if (rawNum) lastGLNumber = rawNum;
      if (rawName) lastGLName = rawName;
      return { row, glNumber: lastGLNumber, glName: lastGLName };
    });

  // ── Steps 4–9: transform each row ────────────────────────────────────────
  const rows: NormalizedRow[] = [];
  const warnings: NormalizeWarning[] = [];

  filled.forEach(({ row, glNumber, glName }, idx) => {
    try {
      // Step 4: split GLNumber by "-"
      const dashIdx = glNumber.indexOf(GL_NUMBER_SEPARATOR);
      const glCode = dashIdx >= 0 ? glNumber.slice(0, dashIdx).trim() : glNumber;
      const branch = dashIdx >= 0 ? glNumber.slice(dashIdx + 1).trim() : "";

      // Step 7: parse date
      const rawDate = col(row, GL_COL.JOURNAL_POST_DATE);
      const journalDate = parseExcelDate(rawDate);
      const journalPostDate = journalDate
        ? journalDate.toISOString().split("T")[0]
        : null;

      // Step 8: derive Year, Month, Movement
      const year = journalDate ? journalDate.getUTCFullYear() : null;
      const month = journalDate ? MONTH_NAMES[journalDate.getUTCMonth()] : null;
      const debit = toNum(col(row, GL_COL.DEBIT));
      const credit = toNum(col(row, GL_COL.CREDIT));

      const checkDesc = trimStr(col(row, GL_COL.CHECK_DESCRIPTION));
      rows.push({
        gl_number_raw: glNumber,
        gl_code: glCode,
        branch,
        gl_name: trimStr(glName), // Step 9: trimmed
        // Steps 5–6: as-is / trimmed; loan/borrower reserved for later
        check_description: checkDesc,
        loan_number: null,
        loan_number_raw: extractLoanNumber(checkDesc),
        borrower_name: null,
        journal_post_date: journalPostDate,
        year,
        month: month ?? null,
        vendor: trimStr(col(row, GL_COL.VENDOR)),
        invoice_numb: trimStr(col(row, GL_COL.INVOICE_NUMB)),
        ref_numb: trimStr(col(row, GL_COL.REF_NUMB)),
        doc_type: trimStr(col(row, GL_COL.DOC_TYPE)),
        debit,
        credit,
        movement: credit - debit,
      });
    } catch (err) {
      warnings.push({
        rowIndex: idx,
        rawGLNumber: glNumber,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return { rows, warnings, sheet, headers, missingColumns };
}
