import type {
  EnrichedTransaction,
  EnrichResult,
  GLMapping,
  Branch,
  NormalizedRow,
} from "@/types";

/**
 * Joins normalized rows against the GL Mapping and Branches lookup tables,
 * producing enriched transaction records ready for database insertion.
 *
 * Rows with no matching GL code are included but left uncategorized (all
 * category_* fields null). Rows with no matching branch are included but
 * left without region/branch_manager. Neither case throws.
 */
export function enrichTransactions(
  rows: NormalizedRow[],
  glMappings: GLMapping[],
  branches: Branch[],
  uploadId: string,
  source: "original" | "addback" | "manual_entry" = "original"
): EnrichResult {
  const glMap = new Map<string, GLMapping>(
    glMappings.map((r) => [r.gl_code, r])
  );
  const branchMap = new Map<string, Branch>(
    branches.map((r) => [r.branch, r])
  );

  let uncategorizedCount = 0;
  let unknownBranchCount = 0;
  /*
   * ⚠ QUE sucursales no existen, no solo CUANTAS filas. Un "142 unknown branch"
   * no se puede resolver; un "70000, 70300, 71000" se lee de un vistazo y dice
   * exactamente que paso -- el export de Blast trae dos ceros de mas.
   *
   * Ese fallo entra sin fallar: el upload dice "completed" y el P&L sale vacio,
   * asi que el unico sintoma es una pantalla en blanco y nadie sabe por que. Ya
   * costo dos correcciones a mano, julio y agosto.
   */
  const unknownBranches = new Set<string>();

  const transactions: EnrichedTransaction[] = rows.map((row) => {
    const glEntry = glMap.get(row.gl_code);
    const branchEntry = branchMap.get(row.branch);

    if (!glEntry) uncategorizedCount++;
    if (!branchEntry) {
      unknownBranchCount++;
      if (row.branch) unknownBranches.add(row.branch);
    }

    return {
      ...row,
      upload_id: uploadId,
      // GL Mapping enrichment (null if no match — not an error)
      category_1: glEntry?.category_1 ?? null,
      category_2: glEntry?.category_2 ?? null,
      category_3: glEntry?.category_3 ?? null,
      category_4: glEntry?.category_4 ?? null,
      category_5: glEntry?.category_5 ?? null,
      category_6: glEntry?.category_6 ?? null,
      category_7: glEntry?.category_7 ?? null,
      order_1: glEntry?.order_1 ?? null,
      order_2: glEntry?.order_2 ?? null,
      order_3: glEntry?.order_3 ?? null,
      // Branch enrichment
      region: branchEntry?.region ?? null,
      branch_manager: branchEntry?.branch_manager ?? null,
      manual_override: false as const,
      source,
    };
  });

  return { transactions, uncategorizedCount, unknownBranchCount, unknownBranches: [...unknownBranches].sort() };
}
