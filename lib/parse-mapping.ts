import { readSheetRaw } from "@/lib/excel-utils";
import { MAP_COL, MAPPING_SHEET_NAME } from "@/lib/constants";

// ─── Output types ─────────────────────────────────────────────────────────────

export interface ParsedGLMapping {
  gl_code: string;
  gl_name: string;
  category_1: string | null;
  category_2: string | null;
  category_3: string | null;
  category_4: string | null;
  category_5: string | null;
  category_6: string | null;
  category_7: string | null;
  order_1: number | null;
  order_2: number | null;
  order_3: number | null;
}

export interface ParsedBranch {
  branch: string;
  region: string | null;
  branch_manager: string | null;
}

/** Debug snapshot of what the parser detected. Returned by the API for verification. */
export interface MappingParseDebug {
  glHeaderRow: number;
  branchHeaderRow: number;
  glColMap: Record<string, number>;
  branchColMap: Record<string, number>;
  categoryIndices: Record<number, number>; // { 1: colIdx, 2: colIdx, ... }
  orderIndices: Record<number, number>;
}

export interface MappingParseResult {
  glMappings: ParsedGLMapping[];
  branches: ParsedBranch[];
  debug: MappingParseDebug;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Normalizes a raw cell value to a canonical lookup key:
 * - Converts ALL Unicode space variants to a plain ASCII space
 *   (this is the primary fix: Excel commonly uses U+00A0 non-breaking spaces
 *   which String.trim() / .toLowerCase() leave intact, breaking exact matches)
 * - Collapses runs of spaces to a single space
 * - Trims, lowercases
 */
function normalizeKey(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v)
    .replace(
      // U+00A0 no-break space, U+2000-U+200A typographic spaces,
      // U+202F narrow no-break, U+205F math medium space, U+3000 ideographic
      /[  -   　]/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function trimStr(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function nullIfEmpty(v: unknown): string | null {
  const s = trimStr(v);
  return s === "" ? null : s;
}

function toIntOrNull(v: unknown): number | null {
  const s = trimStr(v);
  if (!s) return null;
  const n = parseInt(s, 10);
  return isNaN(n) ? null : n;
}

/** Maps every non-empty cell in a header row to its column index (0-based). */
function buildColMap(headerRow: unknown[]): Record<string, number> {
  const map: Record<string, number> = {};
  headerRow.forEach((cell, j) => {
    const key = normalizeKey(cell);
    if (key) map[key] = j;
  });
  return map;
}

/**
 * Scans a column map for columns matching a name pattern, returning
 * { ordinalNumber: columnIndex }.
 *
 * Pattern examples that are matched:
 *   "category 4", "category4", "cat 4", "cat4", "category_4", "category-4"
 *   "order 2", "order2", "order_2"
 *
 * Using regex here — rather than the previous exact-string CATEGORY_PREFIX+n
 * approach — makes the lookup robust against:
 *   - spacing variations ("Category4" vs "Category 4")
 *   - abbreviations ("Cat 4")
 *   - residual whitespace after normalization
 */
function extractByPattern(
  colMap: Record<string, number>,
  wordPattern: RegExp
): Record<number, number> {
  const result: Record<number, number> = {};
  for (const [key, colIdx] of Object.entries(colMap)) {
    const m = key.match(wordPattern);
    if (m) {
      const n = parseInt(m[1], 10);
      if (!isNaN(n)) result[n] = colIdx;
    }
  }
  return result;
}

// cat(egory)? followed by optional separator(s), then the number
const CATEGORY_PATTERN = /^cat(?:egory)?[\s_\-]*(\d+)$/;
// order followed by optional separator(s), then the number
const ORDER_PATTERN = /^order[\s_\-]*(\d+)$/;

// ─── Main parser ──────────────────────────────────────────────────────────────

export function parseMappingFile(buffer: Buffer): MappingParseResult {
  const { rows: raw } = readSheetRaw(
    buffer,
    (name) => name.toLowerCase() === MAPPING_SHEET_NAME
  );

  let glHeaderRowIdx = -1;
  let glColMap: Record<string, number> = {};

  let branchHeaderRowIdx = -1;
  let branchColMap: Record<string, number> = {};

  // ── Scan for header rows ─────────────────────────────────────────────────
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i] as unknown[];
    // Use normalizeKey (not just toLowerCase) for the same whitespace-safety
    const cells = row.map(normalizeKey);

    // GL Mapping header: must have "gl code" AND at least one category column
    if (glHeaderRowIdx < 0) {
      const hasGLCode = cells.includes(MAP_COL.GL_CODE);
      const hasCategory = cells.some((c) => CATEGORY_PATTERN.test(c));
      if (hasGLCode && hasCategory) {
        glHeaderRowIdx = i;
        glColMap = buildColMap(row);
      }
    }

    // Branches header: must have "region" AND "branch"
    if (branchHeaderRowIdx < 0) {
      const hasRegion = cells.includes(MAP_COL.REGION);
      const hasBranch = cells.includes(MAP_COL.BRANCH);
      if (hasRegion && hasBranch) {
        branchHeaderRowIdx = i;
        branchColMap = buildColMap(row);
      }
    }
  }

  // Pre-compute category and order column indices once (outside the data loop)
  const categoryIndices = extractByPattern(glColMap, CATEGORY_PATTERN);
  const orderIndices = extractByPattern(glColMap, ORDER_PATTERN);

  // ── Extract GL Mapping rows ───────────────────────────────────────────────
  const glMappings: ParsedGLMapping[] = [];

  if (glHeaderRowIdx >= 0) {
    const glCodeCol = glColMap[MAP_COL.GL_CODE] ?? -1;
    const glNameCol =
      glColMap[MAP_COL.GL_NAME] ?? glColMap[MAP_COL.GL_NAME_ALT] ?? -1;

    const cat = (n: number) => categoryIndices[n] ?? -1;
    const ord = (n: number) => orderIndices[n] ?? -1;

    for (let i = glHeaderRowIdx + 1; i < raw.length; i++) {
      const row = raw[i] as unknown[];
      const glCode = glCodeCol >= 0 ? trimStr(row[glCodeCol]) : "";
      if (!glCode) continue;

      glMappings.push({
        gl_code: glCode,
        gl_name: glNameCol >= 0 ? trimStr(row[glNameCol]) : "",
        category_1: nullIfEmpty(row[cat(1)]),
        category_2: nullIfEmpty(row[cat(2)]),
        category_3: nullIfEmpty(row[cat(3)]),
        category_4: nullIfEmpty(row[cat(4)]),
        category_5: nullIfEmpty(row[cat(5)]),
        category_6: nullIfEmpty(row[cat(6)]),
        category_7: nullIfEmpty(row[cat(7)]),
        order_1: toIntOrNull(row[ord(1)]),
        order_2: toIntOrNull(row[ord(2)]),
        order_3: toIntOrNull(row[ord(3)]),
      });
    }
  }

  // ── Extract Branch rows ───────────────────────────────────────────────────
  const branches: ParsedBranch[] = [];

  if (branchHeaderRowIdx >= 0) {
    const regionCol = branchColMap[MAP_COL.REGION] ?? -1;
    const branchCol = branchColMap[MAP_COL.BRANCH] ?? -1;
    const managerCol =
      branchColMap[MAP_COL.BRANCH_MANAGER] ??
      branchColMap[MAP_COL.BRANCH_MANAGER_ALT] ??
      -1;

    for (let i = branchHeaderRowIdx + 1; i < raw.length; i++) {
      const row = raw[i] as unknown[];
      const branch = branchCol >= 0 ? trimStr(row[branchCol]) : "";
      if (!branch) continue;

      branches.push({
        branch,
        region: regionCol >= 0 ? nullIfEmpty(row[regionCol]) : null,
        branch_manager: managerCol >= 0 ? nullIfEmpty(row[managerCol]) : null,
      });
    }
  }

  return {
    glMappings,
    branches,
    debug: {
      glHeaderRow: glHeaderRowIdx,
      branchHeaderRow: branchHeaderRowIdx,
      glColMap,
      branchColMap,
      categoryIndices,
      orderIndices,
    },
  };
}
