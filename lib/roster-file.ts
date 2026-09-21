/**
 * ─────────────────────────────────────────────────────────────────────────────
 * EL LISTADO DE PERSONAS: QUIEN ESTA, DONDE Y CON QUE CARGO
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * El modulo de Roster contesta UNA pregunta -- quien trabaja aqui, en que
 * sucursal y con que cargo -- y no lleva importes. El coste de esas personas
 * vive en el P&L, con sus centros de coste, sus notas y sus splits, y NADA de
 * eso se toca desde aqui.
 *
 * Dos poblaciones que casi no se solapan:
 *
 *     org.roster_current           115 personas   la fuente de identidad
 *     archivo offshore              70 personas   el que trae la sucursal
 *     --------------------------------------------------------------------
 *     en las dos                    45
 *     union a listar               140
 *
 * ⚠ CERO SOLAPE CON LAS 68 DE EE.UU. Ninguna de las 45 que casan es de las 68
 * personas de EE.UU. del roster, asi que las dos listas son poblaciones
 * distintas y la union no infla a nadie.
 *
 * ⚠ SETENTA, NO SETENTA Y UNA. El archivo escribe a Jimena Ferrer Gutierrez con
 * y sin segundo nombre --"Jimena Ferrer Gutierrez" y "Jimena Ines Ferrer
 * Gutierrez"-- y las dos son `jimena.ferrer`. Contar nombres en vez de personas
 * la duplica.
 */

/** ── El grupo del archivo que es gente ──────────────────────────────────────
 *
 * `source='offshore_allocations'` trae 981 filas y solo 671 son el roster:
 *
 *     Roster Offshore          671 filas   71 nombres   -1.199.529,52
 *     Vendors Offshore COL     230          55            -215.437,38
 *     Vendors Offshore US       65          19             -81.888,99
 *     Homesi ... payroll        15           1         +1.496.741,35
 *
 * Los vendors NO se copian aqui: sus 295 filas ya llevan la columna `vendor`
 * poblada --46 proveedores distintos-- y el modulo de Vendors lee toda fila con
 * vendor sin mirar el `source`, asi que ya estan ahi. Y las 15 sueltas de
 * "Homesi ... payroll" son asientos de nomina agregada, no personas.
 *
 * ⚠ LAS 15 NO SON TODAS POSITIVAS. Trece lo son; dos son ajustes negativos en
 * 61200 Office Expense, de -41.717,69 y -509,18. Se anota porque el signo
 * invita a resumirlas como "las positivas" y entonces esos dos ajustes
 * desaparecen de la cuenta sin que nadie lo note.
 */
export const GRUPO_ROSTER_EN_EL_ARCHIVO = "Roster Offshore";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * LA SUCURSAL SALE DEL ARCHIVO
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `branch_allocation` es lo que dice quien reparte el coste, y es el unico
 * sitio donde consta que una persona sirve a varias sucursales: de las 70,
 * **23 tienen mas de una**. Igleth Mercado esta en 700, 707 y 716; Karen De Fex
 * en 700, 716 y 747.
 *
 * ⚠ AFFINITY SE ESCRIBE DE TRES MANERAS EN LA MISMA COLUMNA:
 *
 *     Affinity            22 filas   4 personas
 *     Hired by Jim         5         1
 *     Hired by for Jim     2         (la misma)
 *
 * Las tres son lo mismo. Sin unificarlas, David Jose Alvarez Orcasita aparecia
 * con CUATRO sucursales cuando tiene DOS --716 y Affinity--: "Hired by Jim" y
 * "Hired by for Jim" contaban por separado, y un `toUpperCase()` a ciegas
 * partia ademas "Affinity" de "AFFINITY". Se vio al listar sus sucursales, no
 * al contar: el total de personas salia bien con el fallo dentro.
 *
 * Las 671 filas tienen las 70 personas con sucursal: NI UNA sin ella.
 */
export const SUCURSAL_AFFINITY = "Affinity";

export function sucursalDelArchivo(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  if (/^hired\s+by\s+(for\s+)?jim\b/i.test(s)) return SUCURSAL_AFFINITY;
  if (s.toLowerCase() === SUCURSAL_AFFINITY.toLowerCase()) return SUCURSAL_AFFINITY;
  /* Los codigos son numericos: el toUpperCase es para lo que no lo sea. */
  return s.toUpperCase();
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * EL CARGO: MANDA EL ROSTER, Y EL ARCHIVO CUANDO NO ESTA
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ LOS DOS SE GUARDAN, PERO LA DIFERENCIA NO ES UN ASCENSO. Medido sobre las
 * 45 que estan en las dos fuentes: en 31 ningun valor del archivo coincide con
 * el del roster, y al mirarlas NO son cambios de puesto, es vocabulario sucio.
 * "Admin Staff CO" contra "HR GENERALIST" no es una promocion, es un cubo de
 * coste enfrentado a un cargo.
 *
 * Por eso el archivo se guarda y se enseña como dato secundario, SIN etiqueta
 * de ascenso: rotularlo asi pintaria 31 promociones que no existieron.
 *
 * ⚠ Y OJO CON MEDIR ESTO A LA LIGERA. Mi primera medicion dijo "152 de 152
 * difieren" y era falsa por dos motivos a la vez: el roster esta en MAYUSCULAS
 * y el archivo en Title Case, y 53 de las 70 personas tienen DOS O MAS valores
 * de `position` porque la columna mezcla dos vocabularios.
 */

/**
 * Los cubos: valores de `position` que no son un cargo sino una bolsa de coste
 * con el pais pegado. Se descartan cuando la persona tiene algo mas.
 *
 * ⚠ ES UNA LISTA, NO LA REGLA "acaba en CO". `Recruiter CO` tiene la misma
 * forma y SI es un cargo --reclutador en Colombia--, igual que `LOA CO` es
 * asistente y `BD CO` business developer. Lo que hace cubo a estos cuatro es
 * que la misma persona los lleva ADEMAS de su cargo real, no como se escriben.
 */
export const CUBOS_DE_COSTE = new Set([
  "Admin Staff CO",
  "LOA CO",
  "BD CO",
  "Loan Processor CO",
]);

export interface CargoDelArchivo {
  /** El elegido, o null si no hay forma de elegir. */
  cargo: string | null;
  /** Todos los valores crudos, siempre, para poder enseñarlos si no se resuelve. */
  crudos: string[];
  /** Quedan dos y ninguna regla los separa. Se enseñan crudos y marcados. */
  ambiguo: boolean;
}

/**
 * ── LO MEDIDO, 2026-09-18, sobre las 25 personas que NO estan en el roster ───
 *
 *     con un solo valor                               14   directo
 *     con varios                                      11
 *       -- resueltos al quitar los cubos               6
 *       -- resueltos porque uno EXTIENDE al otro       3   "Intern" contra
 *                                                          "Intern (Statutory)"
 *       -- sin resolver                                2
 *
 * Los dos que quedan, con sus valores crudos:
 *
 *     Cristian David Molina Otero   Intern (Statutory) | IT Intern
 *     Jose Alejandro Falquez Doyen  Account Executive  | Business Developer
 *
 * ⚠ NO SE ELIGE POR LONGITUD. Era el atajo obvio para "el mas especifico" y se
 * equivoca justo aqui: daria "Intern (Statutory)" para Cristian, que es su tipo
 * de contrato y no su puesto --el puesto es "IT Intern"--. Dos son pocos: se
 * enseñan crudos y marcados, que es mas honesto que acertar por casualidad.
 */
export function cargoDelArchivo(valores: (string | null)[]): CargoDelArchivo {
  const crudos = [...new Set(valores.map((v) => (v ?? "").trim()).filter(Boolean))];
  if (crudos.length === 0) return { cargo: null, crudos: [], ambiguo: false };
  if (crudos.length === 1) return { cargo: crudos[0], crudos, ambiguo: false };

  // 1. Fuera los cubos, si queda algo.
  const sinCubos = crudos.filter((c) => !CUBOS_DE_COSTE.has(c));
  const quedan = sinCubos.length > 0 ? sinCubos : crudos;
  if (quedan.length === 1) return { cargo: quedan[0], crudos, ambiguo: false };

  // 2. Uno extiende al otro: "Intern" -> "Intern (Statutory)". Gana el largo,
  //    que aqui SI dice mas, porque dice lo mismo y ademas algo.
  const extiende = quedan.filter((c) =>
    quedan.every((o) => o === c || c.toLowerCase().startsWith(o.toLowerCase())),
  );
  if (extiende.length === 1) return { cargo: extiende[0], crudos, ambiguo: false };

  return { cargo: null, crudos, ambiguo: true };
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * LO QUE NO ES UNA PERSONA
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ UNA LISTA, NO UNA HEURISTICA, y la diferencia ya costo cara una vez en este
 * repo: emparejar nombres por parecido es como "CASTRO, JU" funde a Julymar con
 * Juseth, que son dos personas. Una regla de texto que decida quien NO es
 * persona borraria a alguien de verdad sin que nada fallara.
 *
 * Medido: de los 71 nombres del archivo, UNO no es una persona. Por eso no hay
 * contador en la pantalla -- un aviso de "1 fila excluida" pesa mas que el
 * hecho que cuenta.
 */
export const NO_SON_PERSONAS = new Set(["New Hire- IT"]);

/** Minusculas, sin acentos y con los espacios colapsados. */
export function normalizar(nombre: string): string {
  return nombre
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * La clave de nombre y apellido, para cuando el archivo trae segundos nombres
 * que el roster no tiene.
 *
 * ⚠ SOLO SE USA CON GUARDA DE UNICIDAD, en quien la llama. Sin ella funde
 * personas distintas, que es el error que este repo ya documenta en
 * lib/lo-payroll-name.ts.
 */
export function clavePrimeroUltimo(nombre: string): string | null {
  const p = normalizar(nombre).split(" ").filter(Boolean);
  if (p.length < 2) return null;
  return `${p[0]} ${p[p.length - 1]}`;
}
