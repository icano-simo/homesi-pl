// ─── Supabase table shapes ────────────────────────────────────────────────────

export interface GLMapping {
  id: string;
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
  created_at: string;
  updated_at: string;
}

export interface Branch {
  id: string;
  branch: string;
  region: string | null;
  branch_manager: string | null;
  created_at: string;
  updated_at: string;
}

export interface PLUpload {
  id: string;
  file_name: string;
  uploaded_at: string;
  row_count: number | null;
  status: "processing" | "completed" | "error";
  error_message: string | null;
}

export interface PLTransaction {
  id: string;
  upload_id: string;
  gl_number_raw: string | null;
  gl_code: string | null;
  branch: string | null;
  gl_name: string | null;
  check_description: string | null;
  loan_number: string | null;
  loan_number_raw: string | null;
  borrower_name: string | null;
  journal_post_date: string | null;
  year: number | null;
  month: string | null;
  vendor: string | null;
  invoice_numb: string | null;
  ref_numb: string | null;
  doc_type: string | null;
  debit: number;
  credit: number;
  movement: number | null;
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
  region: string | null;
  branch_manager: string | null;
  manual_override: boolean;
  manual_category_7: string | null;
  cost_center_id: string | null;
  cost_center_status: "unassigned" | "assigned" | "conflict" | null;
  cost_center_conflicts: string[] | null;
  loan_number_incomplete: boolean | null;
  cost_centers?: { name: string } | null;
  source: "original" | "addback" | "offshore_allocations" | "manual_entry" | "employee_fee" | null;
  check_description_2: string | null;
  check_description_3: string | null;
  category: string | null;
  position: string | null;
  branch_allocation: string | null;
  operational_pct: number;
  created_at: string;
  // Loan Officials tags — populated by Transaction Review API (not stored on pl_transactions)
  b2b?: boolean | null;
  processing?: boolean | null;
  support_on_demand?: boolean | null;
  affinity?: boolean | null;
  recruitment?: boolean | null;
}

// ─── Cost Centers ──────────────────────────────────────────────────────────────

export interface CostCenter {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface CostCenterEvalResult {
  cost_center_id: string | null;
  cost_center_status: "assigned" | "unassigned" | "conflict";
  cost_center_conflicts: string[];  // unified rule IDs that matched (conflicts only)
  conflict_type?: "underassigned" | "overassigned";
  rule_splits?: Array<{ cost_center_id: string; percentage: number; is_operational: boolean }>;
  operational_pct: number;          // 0–100; proportion of movement that is Operational
}

// ─── Normalization pipeline ───────────────────────────────────────────────────

/** One row after full normalization, before database enrichment. */
export interface NormalizedRow {
  gl_number_raw: string;
  gl_code: string;
  branch: string;
  gl_name: string;
  check_description: string;
  loan_number: string | null;
  loan_number_raw: string | null;
  borrower_name: string | null;
  journal_post_date: string | null;
  year: number | null;
  month: string | null;
  vendor: string;
  invoice_numb: string;
  ref_numb: string;
  doc_type: string;
  debit: number;
  credit: number;
  movement: number;
}

/** A row that failed to parse cleanly; logged in the upload summary. */
export interface NormalizeWarning {
  rowIndex: number;
  rawGLNumber: string;
  message: string;
}

export interface NormalizePLResult {
  rows: NormalizedRow[];
  warnings: NormalizeWarning[];
}

// ─── Enrichment pipeline ──────────────────────────────────────────────────────

/** NormalizedRow after joining against gl_mapping and branches. */
export interface EnrichedTransaction extends NormalizedRow {
  upload_id: string;
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
  region: string | null;
  branch_manager: string | null;
  manual_override: false;
  source: "original" | "addback" | "offshore_allocations" | "manual_entry";
}

export interface EnrichResult {
  transactions: EnrichedTransaction[];
  uncategorizedCount: number;
  unknownBranchCount: number;
}

// ─── API response shapes ──────────────────────────────────────────────────────

/** Standard error envelope for all API routes. */
export interface ApiError {
  error: string;
  details?: unknown;
}

export interface ManualAssignmentSummary {
  total_snapshotted:                 number;
  manual_reapplied:                  number;
  manual_not_found:                  number;
  manual_requires_review:            number;
  conflict_resolved_reapplied:       number;
  conflict_resolved_not_found:       number;
  conflict_resolved_requires_review: number;
}

export interface UploadPLResponse {
  uploadId: string;
  rowCount: number;
  uncategorizedCount: number;
  unknownBranchCount: number;
  parseWarnings: number;
  manualAssignments?: ManualAssignmentSummary;
}

export interface AddbacksUploadResponse {
  uploadId: string;
  rowCount: number;
  uncategorizedCount: number;
  unknownBranchCount: number;
  parseWarnings: number;
  manualAssignments?: ManualAssignmentSummary;
}

export interface OffshoreAllocationsUploadResponse {
  uploadId: string;
  rowCount: number;
  uncategorizedCount: number;
  unknownBranchCount: number;
  parseWarnings: number;
  manualAssignments?: ManualAssignmentSummary;
  employeeFeeLines?: { employees: number; months: number; transactions: number };
}

export interface EmployeeFeeConfig {
  id: string;
  check_description_3: string;
  not_recoverable: boolean;
  fee_amount: number | null;
  created_at: string;
  updated_at: string;
}

export interface TransactionFilters {
  uploadId: string;
  // Multi-select categorical columns
  months: string[];
  years: string[];
  glCodes: string[];
  glNames: string[];
  branches: string[];
  vendors: string[];
  category5s: string[];
  category6s: string[];
  refNums: string[];
  // Cost center filter
  costCenterIds: string[];
  costCenterStatuses: string[];
  // Source filter ('original' | 'addback')
  sources: string[];
  // Offshore Allocations description filters
  check_description_2s: string[];
  check_description_3s: string[];
  // Text search
  description: string;
  // Numeric ranges
  debitMin: string;
  debitMax: string;
  creditMin: string;
  creditMax: string;
  movementMin: string;
  movementMax: string;
}

/** Distinct values per categorical column, used to populate column filter dropdowns. */
export interface TransactionColumnValues {
  month: string[];
  year: string[];
  gl_code: string[];
  gl_name: string[];
  branch: string[];
  vendor: string[];
  category_5: string[];
  category_6: string[];
  ref_numb: string[];
  check_description_2: string[];
  check_description_3: string[];
  source: string[];
}

/** Full filter options including cost centers (replaces /api/transactions/values). */
export interface FilterOptionsResponse extends TransactionColumnValues {
  costCenters: Array<{ id: string; name: string }>;
}

/** Shared transaction shape used by P&L All and Cost Center Report pivot tables. */
export interface PLReportTx {
  id: string;
  month: string | null;
  branch: string | null;
  check_description: string | null;
  vendor: string | null;
  ref_numb: string | null;
  debit: number;
  credit: number;
  movement: number | null;
  gl_code: string | null;
  gl_name: string | null;
  category_2: string | null;
  category_6: string | null;
  category_7: string | null;
  order_1: number | null;
  order_2: number | null;
  order_3: number | null;
  check_description_2?: string | null;
  check_description_3?: string | null;
  loan_number?: string | null;
  // Optional CC fields — present when the CC view is requested
  cost_center_id?: string | null;
  cost_center_status?: string | null;
  cost_centers?: { name: string } | null;
  operational_pct?: number;
}

/** PLReportTx with guaranteed CC fields — used by the "P&L by Cost Center" pivot */
export interface PLReportTxCC extends PLReportTx {
  cost_center_id: string | null;
  cost_center_status: string | null;
  cost_centers: { name: string } | null;
}

// ─── Cost Center Assignment module ────────────────────────────────────────────

export interface AssignmentTx {
  id: string;
  gl_code: string | null;
  gl_name: string | null;
  month: string | null;
  year: number | null;
  branch: string | null;
  check_description: string | null;
  check_description_2: string | null;
  check_description_3: string | null;
  vendor: string | null;
  debit: number;
  credit: number;
  movement: number | null;
  cost_center_id: string | null;
  cost_center_name: string | null;
  assignment_origin: string | null;
  operational_pct: number;
}

export interface AssignmentGroup {
  gl_code: string;
  gl_name: string;
  transactions: AssignmentTx[];
}

/** @deprecated use PLReportTx */
export type CCReportTx = PLReportTx & { category_6: string | null; year: number | null };

export interface CCReportResponse {
  cost_center: CostCenter;
  transactions: PLReportTx[];
}

// ─── Split Rules ─────────────────────────────────────────────────────────────

export interface SplitRule {
  id: string;
  name: string;
  description: string | null;
  is_operational: boolean;
  created_at: string;
  updated_at: string;
}

export interface SplitRuleCondition {
  id: string;
  split_rule_id: string;
  sequence: number;
  logic_connector: "AND" | "OR" | null;
  field: string;
  operator: string;
  value: string;
  group_number: number;
  opens_group: boolean;
  closes_group: boolean;
  created_at: string;
}

export interface SplitRuleAllocation {
  id: string;
  split_rule_id: string;
  cost_center_id: string;
  percentage: number;
  display_order: number;
}

export interface SplitRuleWithDetails extends SplitRule {
  conditions: SplitRuleCondition[];
  allocations: SplitRuleAllocation[];
}

// ─── Loan Officials ───────────────────────────────────────────────────────────

export interface LoanOfficial {
  id: string;
  loan_number: string;
  borrower_name: string | null;
  loan_officer: string | null;
  loan_info_channel: string | null;
  branch: string | null;
  loan_amount: number | null;
  loan_program: string | null;
  loan_processor: string | null;
  lo_assistant: string | null;
  lo_assistant_2: string | null;
  loan_type: string | null;
  lead_source_lo: string | null;
  bd_owner: string | null;
  manually_edited_fields: string[];
  b2b: boolean;
  processing: boolean;
  support_on_demand: boolean;
  affinity: boolean;
  recruitment: boolean;
  month: string | null;
  year: number | null;
  created_at: string;
  updated_at: string;
}

export interface UploadLoanCountResponse {
  rowCount: number;
  month: string | null;
  year: number | null;
  warnings: number;
  merge: {
    inserted: number;
    updated: number;
    preserved_fields: number;
    removed: number;
    kept_historical: number;
  };
  completion: {
    processed: number;
    completed_direct: number;
    completed_from_10: number;
    completed_from_9: number;
    incomplete_no_match: number;
    incomplete_ambiguous: number;
  };
}

// ─── Conflict snapshots ────────────────────────────────────────────────────────

export interface ConflictSnapshot {
  id: string;
  transaction_id: string;
  conflicting_cc_ids: string[];
  is_resolved: boolean;
  resolved_cc_id: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MatchedRuleProposal {
  rule_id: string;
  rule_name: string;
  allocations: Array<{ cost_center_id: string; cc_name: string; percentage: number }>;
  rule_total_percentage: number;
}

export interface ConflictTx {
  id: string;
  gl_code: string | null;
  gl_name: string | null;
  month: string | null;
  year: number | null;
  branch: string | null;
  check_description: string | null;
  check_description_2: string | null;
  check_description_3: string | null;
  vendor: string | null;
  debit: number;
  credit: number;
  movement: number | null;
  conflict_type: "underassigned" | "overassigned";
  total_matched_percentage: number;
  matched_rules: MatchedRuleProposal[];
}

export interface ConflictGroup {
  gl_code: string;
  gl_name: string;
  transactions: ConflictTx[];
}

export interface ResolvedConflictTx extends ConflictTx {
  cost_center_id: string | null;
  resolved_cc: { id: string; name: string } | null;
  resolved_at: string | null;
  operational_pct: number;
  // matched_rules may be empty for pre-migration snapshots (old format)
}

export interface ResolvedConflictGroup {
  gl_code: string;
  gl_name: string;
  transactions: ResolvedConflictTx[];
}

// ─── Vendors ──────────────────────────────────────────────────────────────────

export interface VendorSummary {
  vendor: string;
  vendor_key: string;         // normalized (trim+lowercase) for API calls
  tx_count: number;           // total transactions (within active filters)
  tx_count_unassigned: number;
  branches: string[];
  months: string[];
  years: string[];
  gl_items: { gl_code: string; gl_name: string }[];
  cost_centers: string[];     // display names of assigned CCs
}

export interface TransactionTotals {
  debit: number;
  credit: number;
  movement: number;
}

export interface TransactionsResponse {
  data: PLTransaction[];
  count: number;
  totals: TransactionTotals;
}
