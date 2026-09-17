/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ABRIR LA CUENTA 60105 EN LO QUE DICE COMPENSAFE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * En la rejilla del P&L, `60105 Loan Officer Payroll` es una cuenta opaca: dice
 * cuanto costo y no dice de que. Compensafe lo sabe linea a linea, asi que la
 * fila se despliega en sus componentes.
 *
 *     60105  Loan Officer Payroll         -291.803,96
 *       Commission                         269.790,66
 *       Hourly wages                        95.363,06
 *       Earnings recapture                 -78.133,90
 *       sin explicar                         4.784,14
 *
 * ⚠ NO SE AÑADE NADA AL LIBRO. Es la misma cuenta abierta, no una fila nueva
 * sin gl_code entre las cuentas -- que es lo que habria convertido la rejilla
 * en algo que ya no es el libro mayor.
 *
 * ⚠ Y LOS "SIN EXPLICAR" NUNCA SE REPARTEN ENTRE LOS OTROS TRES. Son la
 * diferencia entre lo que dice el P&L y lo que dice Compensafe: repartirlos
 * afirmaria que las dos fuentes cuadran, y lo que hacen es parecerse.
 */

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠ SOLO LA 716, Y ES UNA CONSTANTE PARA QUE MAÑANA SE AÑADA OTRA SIN BUSCAR
 *   UN CONDICIONAL PERDIDO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Es la unica sucursal donde el P&L y Compensafe reconcilian. Medido el
 * 2026-09-17, enfrentando `60105` del P&L contra Commission + Hourly +
 * Earnings recapture de `comp.payroll_transaction` por `branch_code`:
 *
 *     716    -291.803,96   contra   287.019,82     4.784,14      1,6%
 *
 * ─── LO QUE NO SE HACE, Y POR QUE ──────────────────────────────────────────
 *
 * ⚠ ONCE SUCURSALES NO RECONCILIAN, y no por poco:
 *
 *     sucursal   cuenta 60105   Compensafe    hueco        %
 *     703              -9.606      199.484   189.878   1.977%
 *     700              -2.522       56.185    53.663   2.128%
 *     724             -12.338      165.468   153.130   1.241%
 *     733             -21.017      103.224    82.207     391%
 *     707             -13.226       64.368    51.142     387%
 *     718             -24.984      114.707    89.723     359%
 *     702              -3.087        8.140     5.053     164%
 *     760             -84.827      146.338    61.511      73%
 *     747            -130.555      191.431    60.876      47%
 *     701             -37.520       47.634    10.114      27%
 *     710             -82.849       96.420    13.572      16%
 *
 * ⚠ Y SEIS NO TIENEN ESA CUENTA aunque Compensafe si tenga su nomina:
 *
 *     770   229.145      741    44.727      777    22.919
 *     776    19.619      771     8.800      712     3.000
 *
 * De esas seis, CUATRO si estan en el P&L con cientos de filas --770 con 691,
 * 741 con 367-- o sea que su nomina va por OTRA cuenta y no falta: Steve
 * Badovinac es de la 770 y cobra por 60115. Las otras dos, 776 y 777, no
 * tienen NI UNA fila en el libro: son las sucursales fantasma que ya documenta
 * `lib/loan-branch.ts`, la misma familia que los prefijos 913 y 203.
 *
 * ⚠ Y AL NIVEL DE LA DIVISION TAMPOCO CUADRA, asi que no es un problema de una
 * sucursal suelta: 60105 son 758.146 contra 1.852.781 de Compensafe, y aun
 * sumando las TRES cuentas de produccion --1.540.727-- Compensafe sigue
 * 312.053 por encima, un 20%.
 *
 * ─── LA HIPOTESIS QUE LO EXPLICARIA. NO ESTA MEDIDA ────────────────────────
 *
 * `comp.payroll_transaction.branch_code` es la sucursal DE LA PERSONA, y el
 * P&L contabiliza el coste donde lo contabiliza. Son dos preguntas distintas,
 * y compararlas por sucursal enfrenta poblaciones que no tienen por que
 * coincidir.
 *
 * LA EVIDENCIA QUE LA APOYA: las que mas divergen --703, 724, 718, 707-- son
 * justo las que ya sabemos que tienen gente de otra sucursal cerrando en
 * ellas, o que no tienen a nadie en el roster. Es el mismo desajuste que este
 * modulo ya documenta para los prestamos, con otra cara.
 *
 * ⚠ PERO NO ESTA COMPROBADO, y no se afirma. LA MEDICION QUE LO CONFIRMARIA:
 * cruzar por PERSONA en vez de por sucursal -- emparejar cada linea de
 * Compensafe con su fila de nomina del P&L usando `parseDescription` +
 * `matchDescription` de `lib/lo-payroll-name.ts`, que es justo lo que ya hace
 * el modulo por Loan Officer, y ver si el hueco se cierra.
 *
 * Sin esta nota, quien mire la 703 va a pensar que falta funcionalidad, cuando
 * lo que pasa es que el dato no da.
 */
export const SUCURSALES_CON_DESGLOSE_DE_NOMINA: readonly string[] = ["716"];

/** La cuenta que se abre. Una sola, y por ahora no hay motivo para mas. */
export const DESGLOSE_GL_CODE = "60105";

export function tieneDesgloseDeNomina(branches: readonly string[]): boolean {
  return (
    branches.length === 1 && SUCURSALES_CON_DESGLOSE_DE_NOMINA.includes(branches[0])
  );
}

/** Los cuatro componentes, en el orden en que se leen. */
export interface PayrollBreakdownRow {
  label: string;
  amount: number;
  /** El hueco entre el P&L y Compensafe. Se pinta distinto y nunca se reparte. */
  unexplained?: boolean;
}

/*
 * ⚠ LA LENTE DE AFFINITY NO PARTE ESTA CUENTA, Y NO PUEDE.
 *
 * Se pidio que con la lente de Affinity el componente "Commission" fuera la
 * comision de sus prestamos --20.863,79-- y eso NO PUEDE PASAR: con esa lente
 * no hay NI UNA fila de 60105 en la rejilla. Verificado ejecutando la ruta:
 * 130 filas con "716 + Affinity", 130 con "716 only", CERO con "Affinity".
 *
 * Y no es un defecto: es consecuencia de una regla que ya estaba decidida. La
 * nomina de un loan officer se queda ENTERA en la 716 --solo la comision se
 * reparte por prestamo, y solo la nomina de los AE se mueve-- y la cuenta
 * 60105 ES esa nomina. Una fila de 60105 no cuelga de ningun prestamo, asi que
 * no hay nada que la haga de Affinity.
 *
 * O sea que el desglose vive donde la fila existe: "716 + Affinity" y
 * "716 only", con los mismos 130 apuntes y los mismos cuatro componentes.
 *
 * La comision de los prestamos de Affinity SI se ve, pero en el cierre de
 * debajo de la rejilla, que es donde vive lo que no es una cuenta del libro.
 */
