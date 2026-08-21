/**
 * Branch normalization for loan_officials.
 *
 * loan_officials and pl_transactions name their branches independently, and the
 * two lists do not line up. Measured 2026-08-12:
 *
 *   only in loan_officials : 150, 276, 724, 728, Affinity
 *   only in pl_transactions: 700, 712, 721, 722
 *   in both                : 701 702 703 707 710 716 718 733 741 747 760 770 771
 *
 * Everything that reconciles the two lives here, and only here. If another
 * alias like "Affinity" turns up, this is the one file to change — the filters,
 * the metrics endpoint and the bps base all go through these functions.
 *
 * ─── RULE 1 — MAPPING ──────────────────────────────────────────────────────
 * Branch "Affinity" in loan_officials is branch 716 in the P&L. Its loans
 * belong to 716 and must not be dropped: 31 loans, $11,198,800.
 *
 * ─── RULE 2 — EXCLUSION ────────────────────────────────────────────────────
 * After mapping, any branch that does not start with "7" is not part of this
 * division — we receive nothing for those loans. They are excluded from the
 * count, from the amount, and from the bps base. This is a business rule, not
 * something the data reveals: branches 150 and 276 look like ordinary rows.
 * Measured cost of the exclusion: 4 loans, $1,184,778.
 *
 * Order matters. Mapping runs first, then exclusion — "Affinity" does not start
 * with "7" and would be thrown away by an exclusion-first pass, taking
 * $11.2M of real division volume with it.
 *
 * ─── RULE 3 — CORPORATE BRANCH ─────────────────────────────────────────────
 * Branch 700 is corporate. Its costs are centralized, so its loan volume is the
 * volume of every branch rather than its own — 700 does not appear in
 * loan_officials at all, and treating it as "no loans" would put a zero under
 * every bps it touches. See resolveBaseBranches.
 */

/** Aliases in loan_officials that mean a P&L branch under another name. */
const BRANCH_ALIASES: Record<string, string> = {
  Affinity: "716",
};

/**
 * Branches exempt from the B2B success fee.
 *
 * They do not pay it, so a b2b loan of theirs with no fee is correct and must
 * not raise an alert — the validation exists to find branches that should have
 * been charged and were not. Reported as "branch exempt, not charged" instead.
 *
 * Here, next to the aliases, because it is a fact about a branch and not about
 * one report. Exempting the next one is a line in this list, not a condition
 * copied into a component.
 *
 * Measured 2026-08-17: of the 106 loans with b2b = true, 34 are on these two
 * (733: 32, 776: 2) and never alert; the other 72 sit on seven branches that
 * are charged and do alert when the fee is missing.
 */
export const B2B_FEE_EXEMPT_BRANCHES: readonly string[] = ["733", "776"];

/** True when this branch does not pay the B2B success fee. */
export function isB2BFeeExempt(branch: string | null | undefined): boolean {
  const b = resolveLoanBranchAlias(branch);
  return b !== null && B2B_FEE_EXEMPT_BRANCHES.includes(b);
}

/** The corporate branch: centralized costs, division-wide loan volume. */
export const CORPORATE_BRANCH = "700";

/**
 * Canonical branch for a loan_officials row.
 * Returns null when the loan is not part of this division (Rule 2).
 */
/**
 * Rule 1 alone: the same branch written two ways becomes one.
 *
 * Deliberately separate from normalizeLoanBranch, which also applies Rule 2 and
 * drops everything outside the division. The two rules answer different
 * questions and only one of them belongs to Loan Count.
 *
 *   Rule 1 is IDENTITY. "Affinity" and "716" are one branch under two labels,
 *   so counting them apart splits 77 loans into 46 and 31 and neither figure is
 *   the branch's.
 *
 *   Rule 2 is ACCOUNTING SCOPE — which branches belong to this division's P&L.
 *   Loan Count is not about accounting; it counts the loans in the loan count
 *   file. Applying it there would hide the 4 loans on branches 150 and 276 and
 *   leave the module disagreeing with its own source file, 375 against 379,
 *   for a reason nobody reading the screen could see.
 */
export function resolveLoanBranchAlias(raw: string | null | undefined): string | null {
  const b = (raw ?? "").trim();
  if (!b) return null;
  return BRANCH_ALIASES[b] ?? b;
}

export function normalizeLoanBranch(raw: string | null | undefined): string | null {
  const b = (raw ?? "").trim();
  if (!b) return null;

  const mapped = BRANCH_ALIASES[b] ?? b;      // Rule 1, first
  if (!mapped.startsWith("7")) return null;   // Rule 2, second
  return mapped;
}

/**
 * Which branches the bps denominator should be built from.
 *
 * Returns null to mean "every branch, unfiltered".
 *
 *   no filter          → null   (nothing to narrow)
 *   filter includes 700→ null   (corporate: division-wide volume)
 *   only normal branches → those branches
 *
 * THE MIXED CASE — 700 selected together with, say, 701.
 * The base is the unfiltered total, NOT total + 701. Corporate volume already
 * contains 701's loans, so adding them would count those loans twice and
 * deflate every bps in the report by a silent, filter-dependent amount. A
 * denominator that changes meaning depending on which branches happen to be
 * ticked is worse than one that is occasionally broader than the numerator.
 */
export function resolveBaseBranches(filterBranches: readonly string[]): string[] | null {
  if (filterBranches.length === 0) return null;
  if (filterBranches.includes(CORPORATE_BRANCH)) return null;
  return [...filterBranches];
}

/** True when the bps base ignores the branch filter (Rule 3 in effect). */
export function baseIsDivisionWide(filterBranches: readonly string[]): boolean {
  return resolveBaseBranches(filterBranches) === null;
}
