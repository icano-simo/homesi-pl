/**
 * Matching a loan officer to the person the payroll pays.
 *
 * ─── WHY THIS IS NOT A SIMILARITY SCORE ────────────────────────────────────
 * The two sources write names differently and neither is wrong:
 *
 *   payroll          "LAINO CHEGWIN, GIAN L"   "MARTINEZ, NATHAN"
 *   loan_officials   "Gian Laino"              "Nathan Martinez"
 *
 * Surname first, inconsistent case, a second surname sometimes, a middle
 * initial sometimes. The obvious move is a fuzzy score, and it is the wrong
 * move: the payroll holds "CASTRO, JULY M" and "CASTRO, JUSETH M", two
 * different people, and any similarity ranking has a real chance of handing one
 * person's salary to the other. A wrong match is worse than no match, because a
 * wrong match is invisible.
 *
 * So the rule here is exact on tokens and refuses to guess:
 *
 *   a loan officer matches a payroll person when they share a surname AND a
 *   given name, after case, accents and punctuation are normalized away.
 *
 * Measured over the whole base, 46 officers against 67 paid people:
 *
 *   29  paired
 *    4  undecided — two people written two ways each, see below
 *   13  no candidate at all
 *
 * Of the 13, eleven have no surname anywhere in the payroll accounts — seven
 * appear nowhere in the entire P&L — so they are not matching failures at all.
 * The remaining two are name variants ("Steve"/"STEVEN", "Julymar Mar Castro"
 * against "CASTRO, JULY M") and those are what the alias table is for: a human
 * confirms them one at a time.
 *
 * ─── AND WHY THE MATCH MUST BE 1:1 IN BOTH DIRECTIONS ──────────────────────
 * Requiring only "this loan officer has exactly one candidate" is not enough.
 * loan_officials carries two people under two spellings each, and every one of
 * the four has exactly one candidate:
 *
 *   Galo Rizzo (26 closings)   /  Galo Rizzo Hinojosa (1)      -> RIZZO, GALO F
 *   Frank Rodriguez (7)        /  Frank Enrique Rodriguez (1)  -> RODRIGUEZ-PEREZ, FRANK E
 *
 * Attributing each spelling its candidate's pay counted that pay twice and left
 * the control total 4.540,47 heavy. So a pair is a match only when it is the
 * sole candidate FOR EACH OTHER; all four names stay undecided and visible.
 *
 * That underlying typo is not fixed here and must not be papered over with an
 * alias: it splits the CLOSINGS wherever the application groups by officer, not
 * only the payroll. It is corrected at the source. The migration for the alias
 * table carries the full argument.
 */

/** Suffixes that are not part of a name for matching purposes. */
const SUFFIXES = new Set(["JR", "SR", "II", "III", "IV"]);

/**
 * A name reduced to comparable tokens: uppercase, unaccented, letters only,
 * single letters dropped because "GIAN L" and "Gian" are the same person and
 * the initial carries no information either way.
 */
export function nameTokens(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Z ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !SUFFIXES.has(t));
}

export interface ParsedName {
  surnames: string[];
  given: string[];
}

/**
 * A payroll description: "SURNAMES, GIVEN M".
 *
 * Without a comma the last token is taken as the surname — a fallback for the
 * few rows written the other way round, not the expected shape.
 */
export function parsePayrollName(raw: string): ParsedName {
  const [left, right] = raw.split(",");
  if (right !== undefined) return { surnames: nameTokens(left), given: nameTokens(right) };
  const t = nameTokens(left);
  return { surnames: t.slice(-1), given: t.slice(0, -1) };
}

/** A loan_officials name: given name first, surnames after. */
export function parseOfficerName(raw: string): ParsedName {
  const t = nameTokens(raw);
  return { given: t.slice(0, 1), surnames: t.slice(1) };
}

/** Stable identity for a name however it was written. */
export function personKey(raw: string): string {
  return nameTokens(raw).slice().sort().join(" ");
}

/** Shares a surname and a given name. Nothing weaker counts. */
export function namesAgree(officer: ParsedName, payroll: ParsedName): boolean {
  const ps = new Set(payroll.surnames);
  const pg = new Set(payroll.given);
  return officer.surnames.some((t) => ps.has(t)) && officer.given.some((t) => pg.has(t));
}

export interface MatchInput<O, P> {
  officers: Map<string, O>;
  payroll: Map<string, P>;
  officerName: (o: O) => string;
  payrollName: (p: P) => string;
  /** Confirmed by a human: payroll name -> loan officer name. */
  aliases?: { payroll_name: string; loan_officer: string }[];
}

export interface MatchResult {
  /** officer key -> payroll key. Sole candidate for each other. */
  pairs: Map<string, string>;
  /** Officer keys that matched nothing at all. */
  officersUnmatched: string[];
  /**
   * Officer keys with more than one candidate, or whose only candidate is also
   * claimed by another officer. Never guessed at — they are shown as undecided.
   */
  officersUndecided: string[];
  /** Payroll keys no officer claimed. */
  payrollUnclaimed: string[];
  /** Payroll keys claimed by several officers — the two-spellings case. */
  payrollContested: string[];
  /** How many pairs came from the alias table rather than from the rule. */
  fromAliases: number;
}

/**
 * Pair officers to payroll people, refusing every case it cannot settle.
 *
 * Aliases are applied first and are absolute: a human confirmed them, so they
 * take both sides out of the candidate pools before the rule runs and can never
 * be overruled by it.
 */
export function matchOfficersToPayroll<O, P>(input: MatchInput<O, P>): MatchResult {
  const { officers, payroll, officerName, payrollName } = input;

  const pairs = new Map<string, string>();
  const officerTaken = new Set<string>();
  const payrollTaken = new Set<string>();
  let fromAliases = 0;

  for (const a of input.aliases ?? []) {
    const ok = personKey(a.loan_officer);
    const pk = personKey(a.payroll_name);
    if (!officers.has(ok) || !payroll.has(pk)) continue;
    if (officerTaken.has(ok) || payrollTaken.has(pk)) continue;
    pairs.set(ok, pk);
    officerTaken.add(ok);
    payrollTaken.add(pk);
    fromAliases++;
  }

  const parsedOfficers = new Map<string, ParsedName>();
  for (const [k, o] of officers) if (!officerTaken.has(k)) parsedOfficers.set(k, parseOfficerName(officerName(o)));
  const parsedPayroll = new Map<string, ParsedName>();
  for (const [k, p] of payroll) if (!payrollTaken.has(k)) parsedPayroll.set(k, parsePayrollName(payrollName(p)));

  /** Every candidate, both ways round, before anything is decided. */
  const candidatesOf = new Map<string, string[]>();
  const claimantsOf = new Map<string, string[]>();
  for (const [ok, po] of parsedOfficers) {
    const hits: string[] = [];
    for (const [pk, pp] of parsedPayroll) {
      if (namesAgree(po, pp)) {
        hits.push(pk);
        const claims = claimantsOf.get(pk) ?? [];
        claims.push(ok);
        claimantsOf.set(pk, claims);
      }
    }
    candidatesOf.set(ok, hits);
  }

  const officersUnmatched: string[] = [];
  const officersUndecided: string[] = [];
  for (const [ok, hits] of candidatesOf) {
    if (hits.length === 0) { officersUnmatched.push(ok); continue; }
    // Sole candidate for each other, or it is not a match.
    if (hits.length === 1 && (claimantsOf.get(hits[0]) ?? []).length === 1) {
      pairs.set(ok, hits[0]);
      payrollTaken.add(hits[0]);
    } else {
      officersUndecided.push(ok);
    }
  }

  const payrollContested = [...claimantsOf.entries()].filter(([, c]) => c.length > 1).map(([k]) => k);
  const payrollUnclaimed = [...payroll.keys()].filter((k) => !payrollTaken.has(k));

  return { pairs, officersUnmatched, officersUndecided, payrollUnclaimed, payrollContested, fromAliases };
}

/**
 * The compensation accounts a loan officer can be paid through.
 *
 * These five and no others in the first version. Personnel Costs — payroll tax,
 * employee insurance, vision — is deliberately absent: less than half of its
 * amount can be tied to a named person, and the half that can depends on names
 * truncated at 35 characters ("RAMIREZ DAZA, CRIS", "LAINO CHEGWIN, GIA"),
 * which is exactly where two people collide. The screen says what it left out
 * rather than quietly reporting a smaller cost.
 *
 * Measured truncation, for whoever revisits this: 62305 Employee Insurance 23%
 * of rows at the 35-character cap, 62301 Vision 12%, against 64100 Payroll Tax
 * at 1,1% and 62304 at 0%. If Personnel Costs is ever added, those last two are
 * where to start.
 */
export const LO_COMP_ACCOUNTS: Record<string, string> = {
  "60105": "Loan Officer Payroll",
  "60118": "Loan Officer Assistant",
  "60117": "Sales Manager Payroll",
  "60304": "Sign-On Bonus",
  "60303": "Guarantee",
};

/**
 * Personnel Costs, left out on purpose — and how much is left out with it.
 *
 * Listed so the screen can name the amount instead of letting the reader assume
 * the cost side is complete.
 */
export const LO_COMP_EXCLUDED_ACCOUNTS: Record<string, string> = {
  "64100": "Payroll Tax Expense",
  "62305": "Employee Insurance",
  "62301": "Vision",
  "62304": "Credit From Employee Payroll Deduction",
};
