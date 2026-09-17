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

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠ HAY DOS SUCURSALES MAS QUE NO EXISTEN EN EL P&L, Y NO SE LES PONE ALIAS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Encontradas el 2026-09-15 al restringir el revenue de cada prestamo a su
 * propia sucursal: `pl_transactions` NO TIENE NI UNA LINEA en la 776 ni en la
 * 150, asi que sus prestamos no pueden tener revenue propio -- exactamente la
 * situacion que el alias de Affinity existe para arreglar.
 *
 *     776    8 cierres de la division, 7 sin nada en su sucursal
 *            (todos de Silvio Arteaga). Su revenue esta en 700 y 733.
 *     150    2 cierres, los dos sin nada propio (Anthony Robert DiToma).
 *            Su revenue esta en 733.
 *
 * Y varios de los prestamos de la 776 llevan numero `733...`, lo que apunta en
 * la misma direccion.
 *
 * ⚠ NO SE MAPEAN, Y ESO ES LA DECISION. Affinity se pudo mapear porque TODO su
 * revenue estaba en una sola sucursal, la 716. El de la 776 se reparte entre la
 * 700 y la 733, asi que elegir una seria inventarse a donde pertenece y mover
 * dinero de una sucursal a otra sobre una corazonada. Los 9 prestamos se ven
 * hoy como "todo booked elsewhere", que es cierto y es visible.
 *
 * Quien tenga la respuesta es quien monta el catalogo de sucursales, no esta
 * pantalla.
 */

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠ SIETE SUCURSALES CON PRESTAMOS Y SIN NADIE EN EL ROSTER. NO SE SABE QUE SON
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Medido el 2026-09-16. Estan TODAS en `finance_division.branches` --o sea que
 * el catalogo no las excluye-- y todas empiezan por 7, asi que ninguna de las
 * dos reglas de este archivo las separa. Lo unico que las distingue es que
 * `org.roster_current` no tiene NI UNA persona asignada a ellas:
 *
 *   suc  region          roster  loan_officials  espejo  cuentan  nomina sin
 *                                                                 atribuir
 *   718  No Grouping          0        10           51      10    173.478,67
 *   701  Ana de Anda          0         5           65       5     86.075,19
 *   741  Recruited            0         9          101       9     58.948,51
 *   771  Recruited            0         2            8       2     32.753,50
 *   712  Recruited            0         0            0       0     16.327,29
 *   702  Ana de Anda          0         1           12       1      9.000,46
 *   721  Ana de Anda          0         0            1       0      3.180,45
 *                                                                 ----------
 *                                                                 379.764,07
 *
 * Esos 379.764,07 son el 72,6% de toda la nomina que el modulo de P&L por Loan
 * Officer no consigue atribuir a nadie (523.207,01 en 84 nombres). El otro
 * 27,4% --143.442,94-- si esta en sucursales con gente.
 *
 * ⚠ HAY DOS EXPLICACIONES POSIBLES Y EL DATO APOYA LAS DOS. No se afirma
 * ninguna, ni aqui ni en pantalla:
 *
 *   (a) SU GENTE NO ESTA DADA DE ALTA EN RRHH. De los 22 pares officer-sucursal
 *       de estas siete, DIECIOCHO no aparecen en el roster por ningun lado --
 *       David Kontny, Saidu Quansah, Mason Fowler, Patty Anderson, Hortencia De
 *       Anda, Frank Rodriguez, Karol Gonzalez, Constantino Bovino...-- y son
 *       exactamente los mismos nombres que encabezan la nomina sin atribuir.
 *
 *   (b) SON DE OTRA PARTE DE SUPREME Y SUS PRESTAMOS LLEGAN AQUI. Los otros
 *       CUATRO pares SI estan en el roster, asignados a otra sucursal: Jorge
 *       Zuzunaga cierra en la 718 y es de la 716, Gian Laino cierra en la 741 y
 *       es de la 747, Nathan Martinez en la 741 siendo de la 716, Armando
 *       Tejeda en la 771 siendo de la 707. Y el espejo ya marca como fuera de
 *       la division casi toda su actividad: de los 101 registros de la 741 solo
 *       9 cuentan, de los 51 de la 718 solo 10, de los 65 de la 701 solo 5.
 *
 * ⚠ LO QUE LA PANTALLA HACE: nada. Estas sucursales no se abren desde el modulo
 * de P&L por Loan Officer porque no tienen personal asignado, y su nomina sin
 * atribuir no se enseña en ninguna vista. Eso es correcto mientras no se sepa
 * que son -- pero que no salgan NO significa que no existan, y por eso queda
 * escrito aqui con los numeros en vez de solo con su ausencia.
 *
 * Quien pueda cerrarlo es RRHH, no el codigo: basta con saber si esas personas
 * son de la division.
 */

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * REGLA DE NEGOCIO SIN CODIGO: la exoneracion del B2B success fee
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * LAS SUCURSALES 733 Y 776 NO PAGAN EL B2B SUCCESS FEE.
 *
 * Esto era `B2B_FEE_EXEMPT_BRANCHES` y `isB2BFeeExempt()`, y se retiro el
 * 2026-09-12 al quitar la pestaña B2B de Loan Validation: sin la pestaña y sin
 * el contador de /start, la rama type === "b2b" del endpoint se quedo sin
 * llamador, y con ella el unico consumidor que estas dos cosas tenian.
 *
 * SE BORRA EL CODIGO, NO EL HALLAZGO. Costo averiguarlo y va a hacer falta
 * cuando el usuario retome el tema; si vuelve a consultarse en el futuro es una
 * lista de dos elementos, no una investigacion otra vez.
 *
 * POR QUE IMPORTA: un prestamo b2b de esas dos sin fee es CORRECTO, no un
 * hallazgo. La validacion existe para encontrar sucursales que debieron cobrar
 * y no cobraron. Quien vuelva a escribir esa comprobacion sin esta excepcion va
 * a producir 34 alertas falsas el primer dia, y van a parecer reales.
 *
 * MEDIDO el 2026-08-17 y RE-MEDIDO contra la base el 2026-09-12, al borrar el
 * codigo. Los 106 prestamos con b2b = true, por sucursal:
 *
 *     733          32  ← EXONERADA, nunca alerta
 *     776           2  ← EXONERADA, nunca alerta
 *     ------------------
 *     exentos      34
 *
 *     747          23      716          19      703          14
 *     724          10      150           3      770           2
 *     728           1
 *     ------------------
 *     que cobran   72  en siete sucursales, y si alertan cuando falta el fee
 *     ==================
 *     total       106
 *
 * Las dos cifras coinciden al prestamo un mes despues, asi que la exoneracion
 * no es un artefacto de un corte concreto.
 *
 * Y VA AQUI, junto a los alias, porque es un hecho sobre una sucursal y no
 * sobre un informe. El dia que haya que aplicarla otra vez, exonerar a la
 * siguiente es una linea en una lista de este archivo, no una condicion copiada
 * dentro de un componente.
 *
 * ⚠ Y NO SE ARREGLA DANDOLE CUENTA PROPIA AL FEE. El B2B success fee se detecta
 * por el texto de check_description y no tiene gl_code propio. Eso esta bien
 * asi: ver la nota de memoria del success fee antes de proponer tocar gl 70100.
 */

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * AFFINITY DENTRO DE LA 716: LA BANDERA MANDA, Y ES UNA DECISION
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * El P&L por Loan Officer separa los prestamos de Affinity de los puros de la
 * 716. Quien decide cual es cual es `is_affinity`, NO `branch`.
 *
 * ⚠ ESO NO SE SIGUE DE LOS DATOS. SE MIDIO Y APUNTABA AL CONTRARIO. El
 * 2026-09-17, sobre los 101 cierres que hoy cuentan como 716:
 *
 *     branch = 'Affinity'  ·  is_affinity = true    39 cierres
 *     branch = 'Affinity'  ·  is_affinity = false    1 cierre    <- 700002021363
 *     branch = '716'       ·  is_affinity = false   61 cierres
 *
 * Y las tres cosas que se miraron sobre ese unico prestamo discrepante
 * --700002021363, de Nathan Martinez, 441.849-- decian que era de Affinity:
 *
 *   · NINGUN prestamo tiene is_affinity = true fuera de branch = 'Affinity',
 *     asi que la bandera no añadia ninguna distincion que `branch` no diera.
 *   · Su dinero se reparte entre la 716 y la 700 EXACTAMENTE como los otros 32:
 *     la contabilidad no lo distingue de ninguna forma.
 *   · Cerro en enero de 2026, en pleno rango de Affinity (dic-25 a jul-26), o
 *     sea que tampoco es un corte temporal.
 *
 * ⚠ AUN ASI SE QUEDA EN LA 716, PORQUE EL USUARIO LO DECIDIO. Sabe algo del
 * negocio que el dato no dice. Queda escrito para que nadie "arregle" la
 * discrepancia mirando solo estas tres medidas -- que es exactamente lo que
 * recomendaba quien escribio esto antes de preguntar.
 *
 * ⚠ Y ES SOLO PARA ESTA PANTALLA. `BRANCH_ALIASES` sigue mapeando "Affinity" a
 * 716 para TODO lo demas de la app: en Loan Count, en el P&L por sucursal y en
 * las bps, Affinity ES la 716 y no hay nada que separar. Lo que cambia aqui es
 * que el P&L por Loan Officer puede MIRAR las dos mitades por separado.
 */

/** Las tres lentes del selector cuando la sucursal es la 716. */
export type AffinityLens = "716" | "affinity" | "ambas";

/**
 * Si un cierre cuenta como Affinity.
 *
 * ⚠ SOLO `true` ES AFFINITY. `false` y `null` son 716 puro, y eso incluye el
 * caso de `branch = 'Affinity'` con la bandera en false. No se mira `branch`
 * aqui A PROPOSITO: mirarlo reintroduciria la discrepancia que la decision
 * resuelve.
 */
export function esDeAffinity(isAffinity: boolean | null | undefined): boolean {
  return isAffinity === true;
}

/** Si un cierre entra en la lente elegida. */
export function entraEnLente(
  isAffinity: boolean | null | undefined,
  lente: AffinityLens,
): boolean {
  if (lente === "ambas") return true;
  return esDeAffinity(isAffinity) === (lente === "affinity");
}

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * EL COSTE "AE" DE AFFINITY: UNA REGLA POR PATRON, NO UNA LISTA DE NOMBRES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Los account executives de Affinity se cargan en la 716 y se abonan en la
 * 700, asi que a nivel division se anulan pero la 716 carga el coste. Medido el
 * 2026-09-17:
 *
 *     en la 716    27 filas   -59.349,28
 *     en la 700    27 filas   +59.349,28     <- el traslado a corporativo
 *     de diciembre 2025 a agosto 2026
 *
 * Solo se mueve LA PATA DE LA 716. La de la 700 es el traslado y se queda donde
 * esta: moverla tambien borraria el traslado en vez de reubicar el coste.
 *
 * ⚠ ES UN PATRON Y NO UNA LISTA DE SEIS NOMBRES, por decision del usuario y con
 * razon: una lista se queda vieja en cuanto entra alguien y nadie se entera.
 * Cualquier descripcion que empiece por "AE " en la 60125 entra sola.
 *
 * ⚠ VERIFICADO QUE NO PILLA DE MAS: no hay NI UNA fila que empiece por "AE "
 * fuera de la 60125, y dentro de la 60125 son 27 de las 77 filas de la 716 --
 * las otras 50 son nomina de operaciones normal y no se tocan.
 *
 * ⚠ Y SON SEIS PERSONAS, NO DIECINUEVE. El texto lleva el mes dentro
 * --"AE SERVICES MAY - ..." contra "AE Services July - ..."--, viene TRUNCADO a
 * 35 caracteres y cambia de mayusculas, asi que son 28 descripciones y 17
 * grafias para seis personas. Contar descripciones da 19 y es la trampa:
 *
 *     SHIRLEY MELISSA C...   5 grafias   -22.659,24
 *     ALFREDO ALBERTO P...   4           -18.405,12
 *     DAVID JOSE ALVARE...   4           -15.300,42
 *     YELITZA ZULE...        1            -1.756,03
 *     MAYRA ALEJAND...       2            -1.228,47
 *     JOSE ALEJAND...        1                 0,00   <- se anula solo
 */
export const AE_GL_CODE = "60125";

/** Si una linea de nomina es coste de un account executive de Affinity. */
export function esCosteAE(
  glCode: string | null | undefined,
  descripcion: string | null | undefined,
): boolean {
  return glCode === AE_GL_CODE && /^AE\s/i.test((descripcion ?? "").trim());
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
