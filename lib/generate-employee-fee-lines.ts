import { createServerClient } from "@/lib/supabase-server";
import { evaluateCostCenterRules } from "@/lib/evaluate-cost-center-rules";
import { loadAllSplitRules, loadLoanOfficialFields, enrichTxWithLoanOfficials, fetchUploadTxsForRules } from "@/lib/reevaluate-rule-assigned";
import { syncRuleSplitAllocations, type RuleSplitEntry } from "@/lib/sync-rule-split-allocations";
import { applyEmployeeFeeCostSplits } from "@/lib/apply-employee-fee-cost-splits";
import { buildVersionedSplitsMap, type SplitVersionRow } from "@/lib/split-version-utils";
import { INSERT_CHUNK_SIZE } from "@/lib/constants";
import type { PLTransaction, SplitRuleWithDetails } from "@/types";

type SupabaseClient = ReturnType<typeof createServerClient>;

export interface GenerateEmployeeFeeResult {
  employees_processed: number;
  new_months: number;
  transactions_inserted: number;
  upload_id: string | null;
}

/**
 * Generate synthetic Employee Fee income + cost lines for all employees
 * marked not_recoverable=true in employee_fee_config.
 *
 * Idempotent: skips (employee, month, year) combos that already have
 * an employee_fee income line. Safe to call on every OA upload.
 *
 * Income (GL 90001): evaluated by the cost center rules engine.
 * Cost   (GL 90002): inherits the employee's existing cc_allocation_splits
 *                    (assign_type='description3'); skips rules engine.
 *                    Stays unassigned if the employee has no split yet.
 *
 * @param employeeName  If provided, only process this specific employee.
 */
export async function generateEmployeeFeeLines(
  supabase: SupabaseClient,
  opts: { employeeName?: string } = {},
): Promise<GenerateEmployeeFeeResult> {
  // ── 1. Load active employee fee configs ────────────────────────────────────
  let cfgQuery = supabase
    .from("employee_fee_config")
    .select("check_description_3, fee_amount")
    .eq("not_recoverable", true)
    .not("fee_amount", "is", null)
    .gt("fee_amount", 0);

  if (opts.employeeName) {
    cfgQuery = cfgQuery.eq("check_description_3", opts.employeeName);
  }

  const { data: configs, error: cfgErr } = await cfgQuery;
  if (cfgErr) throw new Error(`employee_fee_config fetch: ${cfgErr.message}`);
  if (!configs || configs.length === 0) {
    return { employees_processed: 0, new_months: 0, transactions_inserted: 0, upload_id: null };
  }

  // ── 1b. Pre-load each employee's cc_allocation_splits (description3) ────────
  // Cost lines inherit these splits respecting temporal versioning: each cost
  // transaction's (month, year) determines which version of the split applies.
  const empNames = (configs as Array<{ check_description_3: string }>).map((c) => c.check_description_3);
  const { data: rawEmpSplits } = await supabase
    .from("cc_allocation_splits")
    .select("assign_value, cost_center_id, percentage, is_operational, effective_from_year, effective_from_month")
    .eq("assign_type", "description3")
    .in("assign_value", empNames);

  const empSplitMap = buildVersionedSplitsMap(
    (rawEmpSplits ?? []).map((r) => ({
      assign_type:          "description3" as const,
      assign_value:         r.assign_value as string,
      cost_center_id:       r.cost_center_id as string,
      percentage:           r.percentage as number,
      is_operational:       ((r.is_operational ?? true) as boolean),
      effective_from_year:  (r.effective_from_year ?? null) as number | null,
      effective_from_month: (r.effective_from_month ?? null) as number | null,
    })) as SplitVersionRow[],
  );

  // ── 2. Load GL mapping for 90001 and 90002 ─────────────────────────────────
  const { data: glRows, error: glErr } = await supabase
    .from("gl_mapping")
    .select("*")
    .in("gl_code", ["90001", "90002"]);
  if (glErr) throw new Error(`gl_mapping fetch: ${glErr.message}`);

  const glMap = new Map<string, Record<string, unknown>>(
    (glRows ?? []).map((r) => [r.gl_code as string, r as Record<string, unknown>]),
  );

  // ── 3. Load branch 700 enrichment (region, branch_manager) ─────────────────
  const { data: brRows } = await supabase
    .from("branches")
    .select("region, branch_manager")
    .eq("branch", "700")
    .limit(1);
  const br700 = brRows?.[0] as { region: string | null; branch_manager: string | null } | undefined;

  // ── 4. For each config, find missing (month, year) combos ──────────────────
  type NewLine = {
    gl_code: string;
    employee: string;
    month: string;
    year: number;
    fee_amount: number;
  };

  const linesToCreate: NewLine[] = [];
  let employeesWithWork = 0;

  for (const cfg of configs as Array<{ check_description_3: string; fee_amount: number }>) {
    const emp = cfg.check_description_3;
    const fee = cfg.fee_amount;

    // Find all months/years this employee has offshore allocation transactions
    const { data: oaMonths, error: oaErr } = await supabase
      .from("pl_transactions")
      .select("month, year")
      .eq("source", "offshore_allocations")
      .eq("check_description_2", "Roster Offshore")
      .eq("check_description_3", emp)
      .not("month", "is", null)
      .not("year", "is", null);
    if (oaErr) throw new Error(`OA months fetch for ${emp}: ${oaErr.message}`);

    if (!oaMonths || oaMonths.length === 0) continue;

    // Distinct month/year combos from OA data
    const oaSet = new Set<string>();
    for (const r of oaMonths as Array<{ month: string; year: number }>) {
      oaSet.add(`${r.month}||${r.year}`);
    }

    // Find which combos already have an income line (idempotency check)
    const { data: existingLines, error: exErr } = await supabase
      .from("pl_transactions")
      .select("month, year")
      .eq("source", "employee_fee")
      .eq("vendor", emp)
      .eq("gl_code", "90001"); // income line — always created together with cost
    if (exErr) throw new Error(`existing fee lines fetch for ${emp}: ${exErr.message}`);

    const existingSet = new Set<string>(
      (existingLines ?? []).map((r: { month: string; year: number }) => `${r.month}||${r.year}`),
    );

    const missing = [...oaSet].filter((k) => !existingSet.has(k));
    if (missing.length === 0) continue;

    employeesWithWork++;
    for (const key of missing) {
      const [month, yearStr] = key.split("||");
      linesToCreate.push({ gl_code: "90001", employee: emp, month, year: Number(yearStr), fee_amount: fee });
      linesToCreate.push({ gl_code: "90002", employee: emp, month, year: Number(yearStr), fee_amount: fee });
    }
  }

  if (linesToCreate.length === 0) {
    return { employees_processed: 0, new_months: 0, transactions_inserted: 0, upload_id: null };
  }

  // ── 5. Create a single pl_uploads record for this generation run ────────────
  const { data: uploadRecord, error: upErr } = await supabase
    .from("pl_uploads")
    .insert({ file_name: "Employee Fee Auto-Generated", status: "processing" })
    .select("id")
    .single();
  if (upErr || !uploadRecord) throw new Error(`Failed to create upload record: ${upErr?.message}`);
  const uploadId = uploadRecord.id as string;

  try {
    // ── 6. Build transaction rows ─────────────────────────────────────────────
    const toInsert = linesToCreate.map((line) => {
      const isIncome = line.gl_code === "90001";
      const glEntry  = glMap.get(line.gl_code);
      const debit    = isIncome ? 0             : line.fee_amount;
      const credit   = isIncome ? line.fee_amount : 0;
      const movement = isIncome ? line.fee_amount : -line.fee_amount;
      const desc     = isIncome
        ? `Employee Fee Income - ${line.employee}`
        : `Employee Fee Cost - ${line.employee}`;

      return {
        upload_id:           uploadId,
        gl_number_raw:       line.gl_code,
        gl_code:             line.gl_code,
        gl_name:             glEntry?.gl_name ?? null,
        branch:              "700",
        check_description:   desc,
        check_description_2: null as string | null,
        check_description_3: null as string | null,
        vendor:              line.employee,
        debit,
        credit,
        movement,
        month:               line.month,
        year:                line.year,
        source:              "employee_fee" as const,
        manual_override:     false,
        loan_number:         null as string | null,
        borrower_name:       null as string | null,
        journal_post_date:   null as string | null,
        invoice_numb:        "",
        ref_numb:            "",
        doc_type:            "",
        category_1:          glEntry?.category_1 ?? null,
        category_2:          glEntry?.category_2 ?? null,
        category_3:          glEntry?.category_3 ?? null,
        category_4:          glEntry?.category_4 ?? null,
        category_5:          glEntry?.category_5 ?? null,
        category_6:          glEntry?.category_6 ?? null,
        category_7:          glEntry?.category_7 ?? null,
        order_1:             glEntry?.order_1 ?? null,
        order_2:             glEntry?.order_2 ?? null,
        order_3:             glEntry?.order_3 ?? null,
        region:              br700?.region ?? null,
        branch_manager:      br700?.branch_manager ?? null,
        // Explicitly Operational (100) — matches the user-confirmed default for
        // employee_fee lines. Stays at 100 until a rule or manual action changes it.
        operational_pct:     100,
      };
    });

    for (let i = 0; i < toInsert.length; i += INSERT_CHUNK_SIZE) {
      const chunk = toInsert.slice(i, i + INSERT_CHUNK_SIZE);
      const { error: insErr } = await supabase.from("pl_transactions").insert(chunk);
      if (insErr) throw new Error(`Insert employee_fee lines: ${insErr.message}`);
    }

    // ── 7. Apply cost center assignments ─────────────────────────────────────
    const [splitRules, loMap] = await Promise.all([
      loadAllSplitRules(supabase),
      loadLoanOfficialFields(supabase),
    ]);

    // Paged: an unbounded select stops at 1000 rows. This runs automatically
    // inside every Offshore Allocations upload, so a large generation run would
    // silently leave its later lines without cost-center assignment.
    const newTxs = await fetchUploadTxsForRules(supabase, uploadId);

    if (newTxs.length > 0) {
      type TxRow = { id: string; gl_code: string; vendor: string | null; year: number | null; month: string | null; [key: string]: unknown };
      const txRows  = newTxs as unknown as TxRow[];
      const incomeTxs = txRows.filter((tx) => tx.gl_code === "90001");
      const costTxs   = txRows.filter((tx) => tx.gl_code === "90002");

      // ── 7a. Income lines (90001): normal rules engine ─────────────────────
      if (incomeTxs.length > 0) {
        const ruleSplitEntries: RuleSplitEntry[] = [];
        const ccUpdates = incomeTxs.map((tx) => {
          const txId     = tx.id;
          const enriched = enrichTxWithLoanOfficials(tx as unknown as Record<string, unknown>, loMap);
          const r        = evaluateCostCenterRules(enriched as unknown as PLTransaction, splitRules as SplitRuleWithDetails[]);
          const origin   = r.cost_center_status !== "assigned" ? null : r.rule_splits ? "rule_split" : "rule";
          if (r.rule_splits) ruleSplitEntries.push({ transaction_id: txId, splits: r.rule_splits });
          return {
            id:                    txId,
            cost_center_id:        r.cost_center_id,
            cost_center_status:    r.cost_center_status,
            cost_center_conflicts: r.cost_center_conflicts.length > 0 ? r.cost_center_conflicts : null,
            assignment_origin:     origin,
            conflict_type:         r.conflict_type ?? null,
          };
        });

        for (let i = 0; i < ccUpdates.length; i += INSERT_CHUNK_SIZE) {
          await Promise.all(
            ccUpdates.slice(i, i + INSERT_CHUNK_SIZE).map((u) =>
              supabase
                .from("pl_transactions")
                .update({
                  cost_center_id:        u.cost_center_id,
                  cost_center_status:    u.cost_center_status,
                  cost_center_conflicts: u.cost_center_conflicts,
                  assignment_origin:     u.assignment_origin,
                  conflict_type:         u.conflict_type,
                })
                .eq("id", u.id),
            ),
          );
        }
        await syncRuleSplitAllocations(supabase, ccUpdates.map((u) => u.id), ruleSplitEntries);
      }

      // ── 7b. Cost lines (90002): inherit employee's existing split ──────────
      // Delegates to shared helper — same logic used by resync-cost-splits route.
      if (costTxs.length > 0) {
        await applyEmployeeFeeCostSplits(supabase, costTxs, empSplitMap);
      }
    }

    // ── 8. Mark upload complete ───────────────────────────────────────────────
    await supabase
      .from("pl_uploads")
      .update({ status: "completed", row_count: toInsert.length })
      .eq("id", uploadId);

    const newMonths = linesToCreate.length / 2; // 2 lines per month

    return {
      employees_processed:  employeesWithWork,
      new_months:           newMonths,
      transactions_inserted: toInsert.length,
      upload_id:            uploadId,
    };
  } catch (err) {
    await supabase
      .from("pl_uploads")
      .update({ status: "error", error_message: err instanceof Error ? err.message : String(err) })
      .eq("id", uploadId);
    throw err;
  }
}
