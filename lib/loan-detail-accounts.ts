/**
 * Which revenue accounts a loan is expected to carry, and what counts as its
 * net result.
 *
 * ─── THE COLUMN RULE ───────────────────────────────────────────────────────
 * A branch earns its margin through different accounts depending on whether it
 * is corporate:
 *
 *   branch 700 (corporate) : DM Margin, RM Margin
 *   every other branch     : Back-end Margin, Front-end Margin, Discount Income
 *
 * RM Margin belongs to 700. The 28 rows sitting on branch 724 are margin 724
 * earns on loans that branch 703 brought in — real revenue for 724, but not
 * revenue from 724's own loans, and this view only ever looks at the loans a
 * branch produces. 724 has its own P&L besides: 773 rows, 30 loans.
 *
 * The rule is a default, not a filter. Measured 2026-08-12, every account
 * appears on both sides of it:
 *
 *   DM Margin        334 in 700 /   3 outside
 *   RM Margin         13 in 700 /  33 outside
 *   Back-end Margin    4 in 700 / 296 outside
 *   Front-end Margin   3 in 700 / 274 outside
 *   Discount Income    3 in 700 / 258 outside
 *
 * So an amount in an account the branch does not "own" is common, not exotic.
 * It is always shown — as an extra column with an amber header — never hidden
 * and never folded silently into a total.
 */

export const CORPORATE_MARGIN_ACCOUNTS = ["DM Margin", "RM Margin"] as const;

export const BRANCH_MARGIN_ACCOUNTS = [
  "Back-end Margin",
  "Front-end Margin",
  "Discount Income",
] as const;

export const ALL_MARGIN_ACCOUNTS: readonly string[] = [
  ...CORPORATE_MARGIN_ACCOUNTS,
  ...BRANCH_MARGIN_ACCOUNTS,
];

/** Accounts expected on a loan, given the branch that produced it. */
export function expectedMarginAccounts(branch: string): readonly string[] {
  return branch === "700" ? CORPORATE_MARGIN_ACCOUNTS : BRANCH_MARGIN_ACCOUNTS;
}

/**
 * category_6 groups that make up the result of a loan. Revenue, and nothing
 * else.
 *
 * DIRECT PRODUCTION COSTS ARE DELIBERATELY OUT. Those amounts are what the
 * BORROWER is charged, per loan, and they are later deducted from the branch on
 * a separate line that carries no loan number. That is why they arrive as
 * credits, and why they were ADDING to the net instead of subtracting from it:
 * loan 710002042266 showed Condo Fees +441.95 and Credit Report +324.75, and
 * its block summed +766.70. Read per loan they manufacture a profit that does
 * not exist. Not a calculation error — the attribution simply does not mean
 * what it looks like it means.
 *
 * Selling, General & Administrative and Personnel Costs are out too, and for a
 * different reason: a marketing campaign is not caused by any one loan, so
 * charging it to one would make the loan look worse for something outside its
 * control.
 */
export const NET_GROUPS: readonly string[] = ["Revenue"];

/** Groups deliberately absent from this view entirely. */
export const NON_NET_GROUPS: readonly string[] = [
  "Direct Production Costs",
  "Selling, General & Administrative (S, G & A)",
  "Personnel Costs",
];

/**
 * What counts as "margin" when deciding whether a loan's margin landed in
 * another month.
 *
 * These three and no others. Front-end Margin, Discount Income, Fee Income and
 * Processing Income are revenue but not margin, and letting them decide the
 * label produced nonsense: loan 710002047078 was tagged "margin in June" on the
 * strength of $89.00 of Fee Income, while its entire actual margin — Back-end
 * Margin $8,816.00 — had landed in May.
 */
export const MARGIN_FOR_PERIOD: readonly string[] = [
  "Back-end Margin",
  "RM Margin",
  "DM Margin",
];
