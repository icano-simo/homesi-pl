import { readSheetRaw } from "@/lib/excel-utils";
import type { LoanOfficial } from "@/types";

type ParsedLoanRow = Omit<LoanOfficial, "id" | "created_at" | "updated_at">;

function trimStr(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function parseYesNo(v: unknown): boolean {
  return trimStr(v).toLowerCase() === "yes";
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || trimStr(v) === "") return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

export type { ParsedLoanRow };

export function parseLoanCount(buffer: Buffer): {
  rows: ParsedLoanRow[];
  warnings: string[];
} {
  const { rows: raw } = readSheetRaw(buffer, () => true);
  if (raw.length < 2) return { rows: [], warnings: [] };

  const headers = (raw[0] as unknown[]).map(trimStr);
  const headersLower = headers.map((h) => h.toLowerCase());
  const dataRows = raw.slice(1) as unknown[][];

  function col(row: unknown[], key: string): unknown {
    const idx = headersLower.indexOf(key.toLowerCase());
    return idx >= 0 ? row[idx] : undefined;
  }

  const rows: ParsedLoanRow[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const loanNumber = trimStr(col(row, "Loan Number"));

    if (!loanNumber) {
      warnings.push(`Row ${i + 2}: empty Loan Number — skipped`);
      continue;
    }
    if (loanNumber.length !== 12 || !/^\d{12}$/.test(loanNumber)) {
      warnings.push(`Row ${i + 2}: "${loanNumber}" is not a 12-digit number — skipped`);
      continue;
    }

    const lo2 = trimStr(col(row, "Role Name - LO Assistant 2")) || null;

    rows.push({
      loan_number: loanNumber,
      borrower_name: trimStr(col(row, "Borrower Name")) || null,
      loan_officer: trimStr(col(row, "Loan Officer")) || null,
      loan_info_channel: trimStr(col(row, "Loan Info Channel")) || null,
      branch: trimStr(col(row, "Branch")) || null,
      loan_amount: toNum(col(row, "Loan Amount")),
      loan_program: trimStr(col(row, "Loan Program")) || null,
      loan_processor: trimStr(col(row, "Loan Processor")) || null,
      lo_assistant: trimStr(col(row, "Role Name - LO Assistant")) || null,
      lo_assistant_2: lo2,
      loan_type: trimStr(col(row, "Loan Type")) || null,
      lead_source_lo: trimStr(col(row, "Lead Source LO")) || null,
      bd_owner: trimStr(col(row, "BD Owner")) || null,
      manually_edited_fields: [],
      b2b: parseYesNo(col(row, "B2B")),
      processing: parseYesNo(col(row, "Processing")),
      support_on_demand: parseYesNo(col(row, "Support on demand")),
      affinity: parseYesNo(col(row, "Affinity")),
      recruitment: parseYesNo(col(row, "Recruitment")),
      month: trimStr(col(row, "Month")) || null,
      year: toNum(col(row, "Year")) as number | null,
    });
  }

  return { rows, warnings };
}
