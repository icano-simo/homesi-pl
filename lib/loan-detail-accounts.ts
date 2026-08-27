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

/**
 * ─── TWO DEFINITIONS OF "MARGIN", BOTH CORRECT ─────────────────────────────
 *
 * Do not unify these. They answer different questions, and merging them would
 * break one of the two screens that depend on them:
 *
 *   MARGIN_RECEIVED_GL_CODES — "did the corporate margin fee get booked for
 *   this loan at all?"  DM Margin (41309) or RM Margin (41307). Used by the
 *   Loan Validation All Loans check and, through its summary, by the roadmap
 *   counter. It is about a booking existing, not about how much.
 *
 *   ALL_MARGIN_ACCOUNTS — "how much margin did this loan earn?"  The five
 *   accounts, Back-end and Front-end and Discount included, because a branch
 *   loan earns through those. Used by the margin net of Table List.
 *
 * The narrow one exists because 41309/41307 are the corporate fee: exactly one
 * of them is expected per loan, so their absence is a finding. The wide one
 * exists because the amount a loan produced is not the corporate fee. Feeding
 * the five accounts into the validation check would silence real findings; the
 * two into the net would go back to reading a fixed 65 bps.
 *
 * WHY BOTH CODES AND NOT ONLY DM. Measured over the 388 banked loans: 316
 * carry only DM, 27 carry both, and 15 carry ONLY RM. Those 15 received their
 * margin and were being reported as missing it — 45 alerts where 30 were real.
 * Existence in either is enough; the two are never added together, and the
 * screen shows each amount in its own column so nothing is conflated.
 */
export const MARGIN_RECEIVED_GL_CODES = {
  dm: "41309",
  rm: "41307",
} as const;

export const MARGIN_RECEIVED_GL_LIST: readonly string[] = [
  MARGIN_RECEIVED_GL_CODES.dm,
  MARGIN_RECEIVED_GL_CODES.rm,
];

/**
 * Whether a loan came in through a banked channel.
 *
 * One definition because there were two, and they only agreed by luck: the loan
 * detail matched on `startsWith("Banked")` while loan validation matched on
 * `= "Banked - Retail"`. Today the data holds one banked value (388 of 436, the
 * other 48 Brokered) so both return the same set — but the column is named for
 * a family, and the day a second banked channel appears one screen would take
 * it and the other would drop it, silently and in opposite directions.
 *
 * The prefix is the right test. A channel called "Banked - Something" is banked.
 */
export function isBankedChannel(channel: string | null | undefined): boolean {
  return (channel ?? "").trim().startsWith("Banked");
}

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
