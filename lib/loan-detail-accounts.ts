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
 * ═══════════════════════════════════════════════════════════════════════════
 * TRES DEFINICIONES DE "MARGEN", LAS TRES CORRECTAS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No las unifiques. Responden preguntas distintas y ya estuvimos a punto de
 * fundirlas una vez; juntarlas rompe alguna de las tres pantallas que dependen
 * de ellas.
 *
 *   MARGIN_GRANTING_GL_CODES  ¿se contabilizo algo de margen para este
 *                             prestamo?  Cuatro codigos GL, por EXISTENCIA.
 *                             Loan Validation All Loans, y el contador del
 *                             roadmap a traves de su resumen.
 *
 *   los mismos, SUMADOS       ¿a cuanto salio?  La suma de esas cuatro sobre
 *                             el importe del prestamo. Los bps de Loan
 *                             Validation.
 *
 *   ALL_MARGIN_ACCOUNTS       ¿cuanto margen produjo?  Cinco category_7 --
 *                             Back-end, Front-end, Discount, DM, RM. El neto
 *                             de margen de Table List.
 *
 * Meter las cinco category_7 en la comprobacion silenciaria hallazgos reales;
 * meter estos cuatro codigos en el neto lo devolveria a leer 65 bps fijos.
 *
 * ─── LA PRUEBA DE PERTENENCIA: ¿PUEDE SER LO UNICO QUE UN PRESTAMO TENGA? ──
 *
 * Una cuenta OTORGA margen si un prestamo que solo tuviera esa cuenta habria
 * recibido margen. Es lo que separa las cuatro de abajo de todo lo demas:
 *
 *   41309  DM Margin                    350 prestamos   +777.592
 *   41307  RM Margin                     43             + 36.930
 *   41306  BM Margin                    329             +3.748.787
 *   41870  Brokered Origination Income   31             + 207.725
 *
 * ⚠ 41305 LO Margin NO ESTA, Y NO ES UN OLVIDO. Es margen CEDIDO al loan
 * officer -- una distribucion de lo ganado, no un ingreso. 290 de sus 315
 * filas son negativas, total -2.063.063. Sumarlo convierte en perdida
 * prestamos que ganaron:
 *
 *   710002042266   sin el 327,5 bps   con el -100,7
 *   770002038757   sin el 415,0 bps   con el  -66,0
 *
 * Y para el estado decide exactamente UN prestamo: el unico que tiene LO
 * Margin y nada mas, con importe negativo. Marcarlo como "recibio margen"
 * seria decir lo contrario de lo que paso. Viaja en columna propia, porque
 * cuanto se cedio es informacion util; lo que no puede es entrar en la suma.
 *
 * ⚠ 41308 LO Comp - BPS tampoco: comparte category_7 'Front-end Margin' con
 * 41305, o sea que el propio mapeo contable dice que es la misma naturaleza.
 * Cuatro prestamos, ninguno en solitario.
 *
 * ⚠ 42109 Corp Margin - Branch Concessions tampoco: cinco filas positivas
 * contra cinco negativas es un AJUSTE sobre el margen, no una concesion de
 * margen. Cinco prestamos, ninguno en solitario.
 *
 * ⚠ 41200 Discount Income y 41100 Origination Income tampoco, y aqui la razon
 * es medida y no conceptual: salvan CERO prestamos adicionales -- todos los
 * que las llevan ya llevan una de las cuatro. Pero ojo, que deja una
 * inconsistencia deliberada: Discount Income SI esta en ALL_MARGIN_ACCOUNTS,
 * o sea en el neto de Table List. Dos definiciones distintas a proposito.
 *
 * ─── ⚠ Y ALGO QUE HAY QUE ARREGLAR EN OTRA PANTALLA ────────────────────────
 *
 * EL NETO DE MARGEN DE TABLE LIST LLEVA DENTRO MARGEN CEDIDO AL LO, SIN
 * SABERLO. ALL_MARGIN_ACCOUNTS va por category_7, y 41305 LO Margin cae en
 * 'Front-end Margin' -- asi que esos -2.063.063 estan restando dentro de un
 * neto que se lee como "lo que el prestamo produjo".
 *
 * NO se toca aqui: es otra pantalla y otra decision, y cambiarlo de paso
 * moveria cifras que nadie esta mirando ahora. Queda escrito para cuando se
 * revise Table List.
 *
 * ─── POR QUE CUATRO Y NO DOS ───────────────────────────────────────────────
 *
 * Eran DM y RM, y solo sobre banked. Medido sobre los 436 prestamos:
 *
 *                prestamos   regla vieja   regla nueva   se salvan
 *   banked           388          30            13           17
 *   brokered          48          48            18           30
 *   TOTAL            436          78            31           47
 *
 * Las 47 que se salvan tenian su margen exactamente donde debia estar: las 17
 * banked en BM Margin y las 30 brokered en Brokered Origination Income,
 * ninguna repartida. Los brokered ni siquiera se miraban.
 */
export const MARGIN_GRANTING_GL_CODES = {
  dm: "41309",
  rm: "41307",
  bm: "41306",
  brokered: "41870",
} as const;

export const MARGIN_GRANTING_GL_LIST: readonly string[] = Object.values(
  MARGIN_GRANTING_GL_CODES,
);

/**
 * Margen CEDIDO al loan officer. Se muestra, nunca se suma con las de arriba.
 * Ver la nota: sumarlo da bps negativos en prestamos que ganaron.
 */
export const MARGIN_CEDED_GL_CODE = "41305";

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
