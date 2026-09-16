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
 *   MARGIN_DIVISION_GL_LIST   ¿se llevo la DIVISION su margen?  Por
 *                             EXISTENCIA. Loan Validation All Loans, y el
 *                             contador del roadmap a traves de su resumen.
 *
 *   MARGIN_BRANCH_GL_LIST     ¿se quedo la SUCURSAL el suyo?  La otra mitad de
 *                             la misma pantalla, y una pregunta independiente:
 *                             95 prestamos tienen uno y no el otro.
 *
 *   cada grupo, SUMADO        ¿a cuanto salio cada uno?  Dos columnas de bps,
 *                             nunca una. Ver la nota de los dos grupos.
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
 *   41200  Discount Income              295             +1.567.162
 *   41305  LO Margin                    308             -2.063.063
 *   41870  Brokered Origination Income   31             + 207.725
 *
 * ⚠ 41308 LO Comp - BPS queda fuera: cuatro prestamos, ninguno en solitario,
 * asi que no decide ningun estado. Es la unica razon por la que esta fuera --
 * una decision barata sobre un caso que hoy no existe.
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
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Y SON DOS GRUPOS, NO UNO: QUIEN SE LLEVA EL MARGEN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ⚠ NO LOS SUMES EN UN SOLO NUMERO. Lo estuvieron un rato y escondia justo lo
 * que la validacion existe para encontrar.
 *
 *   DIVISION  41309 DM + 41307 RM + 41870 contabilizado en la 700
 *             lo que se lleva la division por el prestamo
 *   BRANCH    41306 BM + 41200 Discount + 41305 LO Margin + 41870 en sucursal
 *             lo que se queda la sucursal que lo produjo -- las mismas cuentas
 *             que muestran las Mini P&L Cards
 *
 * Son dos cobros distintos a dos destinatarios distintos, y cada uno puede
 * faltar sin el otro. Medido sobre los 436:
 *
 *   con margen de division        360
 *   con margen de branch          358
 *   SOLO division, sin branch      48   <- cobro la division y la sucursal no
 *   SOLO branch, sin division      46   <- cobro la sucursal y la division no
 *
 * Esos 94 pasaban como "recibio margen" con un numero unico. Un prestamo con
 * margen de division y sin margen de sucursal no tiene nada raro EN ESE NUMERO
 * -- y a la sucursal no le llego nada.
 *
 * ─── Y LA PRUEBA DE QUE SON DOS MEDIDAS Y NO UNA ───────────────────────────
 *
 * Sus bps no se parecen en nada:
 *
 *   DIVISION     801.593    mediana  65,0
 *   BRANCH     3.452.668    mediana 300,0   min -111,3   max 425,0
 *
 * La mediana de division es EXACTAMENTE 65,0 porque es un baremo: un
 * porcentaje fijo del importe. La de branch se reparte de 0 a 485 porque es el
 * margen real del prestamo. Promediarlas da un numero que no es ninguna de las
 * dos -- el mismo error que tenia el neto de Table List cuando leia 65 bps
 * fijos y parecia un indicador.
 */
export const MARGIN_DIVISION_GL_CODES = {
  dm: "41309",
  rm: "41307",
  brokered: "41870",
} as const;

export const MARGIN_BRANCH_GL_CODES = {
  bm: "41306",
  discount: "41200",
  /**
   * LO Margin. Un COMPONENTE DEL MARGEN de la sucursal, del estilo de un
   * upfront margin.
   *
   * ⚠ NO ES COMPENSACION DEL LOAN OFFICER pese al nombre, y no tiene ninguna
   * relacion con comp.loan_commission. Esta rama llego a describirlo como
   * "margen cedido al LO" y era falso; si encuentras ese texto en algun sitio,
   * es un resto que hay que borrar.
   *
   * Que su total (-2.063.063) no se parezca al de Compensafe (933.929) no es
   * una discrepancia que explicar: son magnitudes de cosas distintas.
   */
  loMargin: "41305",
  brokered: "41870",
} as const;

/**
 * ⚠ 41870 ESTA EN LOS DOS GRUPOS, Y NO ES UN ERROR.
 *
 * Lo que decide es DONDE ESTA CONTABILIZADO el apunte, no en que lista
 * aparece. Es el mismo criterio de la columna ambar del P&L: la cuenta se juzga
 * contra la sucursal donde esta la transaccion.
 *
 *   Brokered Origination en una sucursal   34 filas · 207.724,91  -> branch
 *   Brokered Origination en la 700          4 filas ·       0,00  -> division
 *
 * Esos cuatro suman exactamente cero entre si: es un traslado, no un ingreso.
 * Asignarlos a `branch` con una lista fija los habria metido en el margen de
 * una sucursal que nunca los recibio.
 *
 * La funcion resuelve por ubicacion para CUALQUIER cuenta que este en los dos
 * grupos, no solo para esta. Hoy 41870 es la unica; si mañana hay otra, no hay
 * que tocar codigo.
 */
/**
 * ─── DOS PREGUNTAS QUE ALGUIEN VA A VOLVER A HACERSE ───────────────────────
 *
 * 1. «BRANCH MARGIN INCLUYE LO MARGIN, QUE ES NEGATIVO. ¿NO HABRIA QUE
 *    RESTARLO?»  NO. Ya resta.
 *
 *    Se suman los movimientos tal como vienen y el signo hace el trabajo. Es
 *    el criterio de toda la app: `movement = credit - debit`, lo positivo suma
 *    y lo negativo resta. Una resta explicita para 41305 lo restaria DOS veces.
 *
 *    Comprobado con el prestamo 710002042266:
 *
 *      41200 Discount Income   +9.602,39
 *      41305 LO Margin         -9.602,39
 *      41306 BM Margin         +7.176,00
 *                              ─────────
 *                               7.176,00
 *
 *    Por eso `marginGroupOf` solo dice a que grupo pertenece cada apunte, y
 *    nunca toca el signo.
 *
 * 2. «¿DIVISION MARGIN MIRA LA CUENTA DE BROKER?»  SI, pero solo cuando esta
 *    contabilizada en la 700.
 *
 *    Hoy esas cuatro filas suman 0,00, asi que no aporta nada al total. La
 *    regla no esta puesta por lo que hace hoy sino para el dia que aporte: si
 *    manaña la 700 registra ahi un ingreso de verdad, entra en el margen de la
 *    division sin que haya que tocar nada.
 */
export type MarginGroup = "division" | "branch";

export function marginGroupOf(glCode: string | null, branch: string | null): MarginGroup | null {
  const inDivision = (Object.values(MARGIN_DIVISION_GL_CODES) as string[]).includes(glCode ?? "");
  const inBranch = (Object.values(MARGIN_BRANCH_GL_CODES) as string[]).includes(glCode ?? "");
  if (inDivision && inBranch) return branch === "700" ? "division" : "branch";
  if (inDivision) return "division";
  if (inBranch) return "branch";
  return null;
}

/** Todas, solo para pedirlas a la base de una vez. Nunca para sumarlas juntas. */
export const MARGIN_ALL_GL_LIST: readonly string[] = [
  ...new Set([
    ...Object.values(MARGIN_DIVISION_GL_CODES),
    ...Object.values(MARGIN_BRANCH_GL_CODES),
  ]),
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
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * QUE ENTRA EN EL RESULTADO DE UN PRESTAMO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ⚠ ERA SOLO "Revenue", Y ESO HACIA QUE ESTA PANTALLA Y EL P&L POR LOAN
 * OFFICER DIERAN NUMEROS DISTINTOS PARA EL MISMO PRESTAMO. En 710002042266,
 * 7.986,43 aqui contra 8.403,13 alli, y la diferencia eran tres costes
 * --tasacion, informe de credito, condominio-- que SI causa el prestamo.
 *
 * Dos definiciones de "lo que dejo este prestamo" viviendo en dos pantallas es
 * el patron que este proyecto lleva desmontando desde el principio: no falla
 * nada, las dos parecen correctas, y se descubre comparando.
 *
 * ─── LO QUE MUEVE EL CAMBIO, MEDIDO EL 2026-09-15 ──────────────────────────
 *
 *   neto agregado    5.592.262,71  ->  5.624.133,60   +31.870,89   (+0,57%)
 *   prestamos que cambian de cifra                542 de 712
 *   prestamos CON revenue que cambian de signo      0
 *   prestamos sin ninguna linea de revenue        121, que pasan de no tener
 *                                                 cifra a tener -20.721,45
 *                                                 entre todos
 *
 * Ni un solo prestamo con ingresos pasa a negativo. Los 121 que aparecen en
 * rojo son prestamos que hoy no enseñan nada y SI tienen coste apuntado: verlo
 * es el objetivo, no un efecto secundario.
 *
 * ⚠ SG&A Y PERSONNEL SIGUEN FUERA, y por su razon original: una campaña de
 * marketing no la causa un prestamo. Ademas no cambiarian nada -- 70100
 * Marketing son 270 lineas en 100 prestamos que suman EXACTAMENTE 0,00, y
 * 60125 Operations Payroll otras 24 en 12, igual.
 */
export const NET_GROUPS: readonly string[] = ["Revenue", "Direct Production Costs"];

/** Groups deliberately absent from this view entirely. */
export const NON_NET_GROUPS: readonly string[] = [
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
