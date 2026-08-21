const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export interface Period {
  month: string;
  year: number;
}

/**
 * The period a monthly close is about: the month immediately before today.
 *
 * Computed from the clock on every load, not stored and not derived from the
 * data. Two things it deliberately is NOT:
 *
 *   - the last month of the year. Defaulting to December is right for one month
 *     of twelve.
 *   - the newest period that happens to be loaded. That reads as the answer
 *     while data is being loaded and stops being it the moment the next file
 *     lands, so the screen would quietly change what it is about.
 *
 * In January it is December of the year before, which is the case worth
 * remembering: the year has to roll back with the month.
 *
 * @param now injectable so the rollover can be tested without waiting a year.
 */
export function closePeriod(now: Date = new Date()): Period {
  const m = now.getMonth();          // 0 = January
  return m === 0
    ? { month: MONTHS[11], year: now.getFullYear() - 1 }
    : { month: MONTHS[m - 1], year: now.getFullYear() };
}

export { MONTHS as MONTH_NAMES_IN_ORDER };
