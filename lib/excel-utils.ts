import * as XLSX from "xlsx";

/**
 * Reads an Excel buffer and returns the target sheet as a raw 2-D array.
 * The sheet is selected by the first name that satisfies `sheetMatcher`;
 * falls back to the first sheet in the workbook if none matches.
 *
 * All values are returned raw (no date coercion, no type guessing) so that
 * each parser can apply its own coercion rules explicitly.
 */
export function readSheetRaw(
  buffer: Buffer,
  sheetMatcher: (name: string) => boolean
): { rows: unknown[][]; sheet: { name: string; matched: boolean } } {
  const workbook = XLSX.read(buffer, {
    type: "buffer",
    cellDates: false,
    raw: true,
  });

  // The fallback to the first sheet is deliberate — plenty of exports name the
  // sheet differently — but the caller has to be told, because a file with no
  // matching sheet and the wrong headers parses into rows where every column is
  // undefined and nothing says so.
  const matched = workbook.SheetNames.find(sheetMatcher);
  const sheetName = matched ?? workbook.SheetNames[0];

  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return { rows: [], sheet: { name: sheetName ?? "", matched: false } };

  return {
    rows: XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: null,
      raw: true,
    }) as unknown[][],
    sheet: { name: sheetName, matched: matched !== undefined },
  };
}
