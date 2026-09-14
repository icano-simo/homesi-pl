/**
 * ─────────────────────────────────────────────────────────────────────────────
 * EMPAREJAR UN NOMBRE DE NOMINA CON UNA PERSONA
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * La nomina del P&L vive en texto libre dentro de `check_description`, con el
 * apellido primero: "LAINO CHEGWIN, GIAN L". Eso no es un nombre canonico de
 * ninguna fuente, asi que hay que normalizarlo antes de cruzarlo con nada.
 *
 * Este archivo es el UNICO sitio donde se decide si dos textos son la misma
 * persona. No hay base de datos aqui a proposito: entra texto, sale una clave o
 * un veredicto, y por eso se puede medir sin montar nada.
 *
 *
 * ── LO QUE SE MIDIO, 2026-09-14, sobre los 46 loan officers de loan_officials ─
 *
 *     regla                                          aciertos   ambiguos
 *     ------------------------------------------------------------------
 *     candidato unico mutuo (la primera que hubo)         29     los que
 *                                                                descuadraron
 *                                                                el total
 *     normalizacion + contencion, contra Supabase         31        0
 *     person_name_key de BigQuery, sola                   28        0
 *     LAS DOS UNIDAS                                      34        0
 *
 * ⚠ PERSON_NAME_KEY SOLA ES PEOR QUE LA NORMALIZACION, y esa es la medicion que
 * justifica que haya dos caminos y no uno. `dim_person`, de donde sale, tiene
 * 111 personas; `roster_current` 114 y `dim_employee` 127. Son poblaciones
 * distintas, no una contenida en la otra: 18 de los 46 loan officers NO ESTAN
 * en dim_person --David Kontny, Isabel Wagner, Ludwig Aguillon, Patty Anderson,
 * Hortencia De Anda, Karol Gonzalez, Saidu Quansah, Sergio Vermejo, Frank
 * Rodriguez y nueve mas--. Dar por hecho que la tabla de BigQuery era la
 * respuesta completa habria perdido a esos 18 sin que nadie se enterara.
 *
 * Al reves, person_name_key resuelve lo que la normalizacion no puede:
 * "steve badovinac" y "steven badovinac" son la misma persona y ningun
 * algoritmo de texto lo sabe -- hay que preguntarlo.
 *
 *
 * ── LAS CUATRO FORMAS DEL TEXTO, con lo que mueve cada una ───────────────────
 *
 *     forma                          filas   movimiento    ¿en el total?
 *     ---------------------------------------------------------------------
 *     APELLIDO, NOMBRE               2.722   -2.577.544    SI
 *     email                            301      -12.985    SI
 *     PREFIJO-Nombre Apellido        2.450      -88.402    no, aparte
 *     "... FOR Apellido, Nombre"         5      +14.096    no, aparte
 *     sin forma de nombre            3.554   -1.496.907    no (alquiler,
 *                                                          publicidad, sucursal)
 *
 * LA FORMA DE LA COMA LLEVA EL 96% DEL DINERO ATRIBUIBLE. Las dos fragiles son
 * 2.455 filas de parsing delicado por el 3,3%, y se midio a quien dejarian mal
 * clasificado: Silvio Arteaga (+252,00), Stephanie Garcia (-197,82) y Susan
 * Aguilar (+126,00) aparecen SOLO en formas fragiles. Ciento ochenta dolares
 * entre los tres. Mario Ballon parecia estar en el mismo caso y no lo estaba:
 * entra por la coma con -10.108,00.
 *
 * ⚠ PERO NO SE OCULTAN. Esos 180 dolares se muestran en la ficha de cada uno,
 * fuera del total y etiquetados como atribucion menos fiable. Si no, esas tres
 * personas caerian en "sin nomina localizada" y eso seria FALSO -- y falso de la
 * peor manera, porque se leeria como un hallazgo.
 *
 *
 * ── EL EMAIL NO ES UNA HEURISTICA MAS ───────────────────────────────────────
 *
 * Entra en el total por un motivo distinto del resto: el local part de un correo
 * de la casa ES el person_code. No se parece, es. La propia vista de BigQuery lo
 * usa asi --`corporate_directory_raw` se une por `email_local = person_code`--,
 * de modo que "ZoomPlus-stephanie.garcia@supremelending.com" resuelve exacto y
 * gratis, sin comparar nombres.
 *
 *
 * ── LO QUE NO HACE, Y NO ES UN OLVIDO ───────────────────────────────────────
 *
 * NO EMPAREJA POR PARECIDO. Ni distancia de edicion, ni prefijos sueltos. El
 * truncamiento del P&L es a 35 caracteres --"04/26 SUN LIFE - LAINO CHEGWIN,
 * GIA"-- y ahi es exactamente donde dos personas se cruzan: "CASTRO, JU" puede
 * ser Julymar o Juseth, que son dos personas distintas y las dos tienen nomina.
 * Un prefijo sin guarda de unicidad las funde.
 *
 * Por eso toda regla que no sea igualdad exacta exige UN SOLO CANDIDATO. Con dos
 * o mas, el resultado es "ambiguo", que se pinta distinto de "sin localizar" y
 * de "cero". Medido: cero ambiguos con estas reglas sobre los 46.
 *
 * NO CONVIERTE "no localizado" EN CERO. Son cosas distintas y la pantalla las
 * distingue: siete loan officers --DiToma, Edwards, Heibel, Holmes, Fowler,
 * Tirio y Winter-- no tienen NI UNA fila en las 13.642 del P&L. Eso no es un
 * fallo de emparejamiento, es el hallazgo que este modulo existe para enseñar.
 */

/** Como queda un nombre despues de normalizarlo: "gian laino chegwin". */
export type NameKey = string;

/**
 * La normalizacion canonica, copiada de `hr_centralizado.person_name_key`.
 *
 * Se replica en vez de inventar otra porque las dos claves tienen que poder
 * compararse: alli es NFD + quitar diacriticos + minusculas + todo lo que no
 * sea [a-z ] a espacio + colapsar. Un guion acaba en espacio por esa via, que es
 * lo que hace que "RAMIREZ-DAZA" y "RAMIREZ DAZA" sean la misma persona.
 *
 * ⚠ SI CAMBIA ALLI, CAMBIA AQUI. Es el unico acoplamiento real entre este
 * archivo y BigQuery, y es deliberado: dos normalizaciones distintas darian dos
 * claves que no casan nunca, y el sintoma seria "no localizado" en masa.
 */
export function normalizeName(raw: string | null | undefined): NameKey {
  if (!raw) return "";
  return raw
    .normalize("NFD")
    // U+0300..U+036F: los diacriticos que NFD acaba de separar de su letra.
    // Escrito con escapes y no con los caracteres literales a proposito: son
    // invisibles en un editor y cualquier recodificacion del archivo los
    // rompe sin dejar rastro.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Conceptos que la contabilidad mete DENTRO del campo del nombre.
 *
 * Reales, no hipoteticos: "OTTONE, DANIELLA SIGN ON BONUS" y
 * "LOPEZ BOGGIO, JOSE A RECLASS". Sin quitarlos, la clave sale
 * "daniella sign on bonus ottone" y no casa con nadie.
 */
const CONCEPTOS_INCRUSTADOS = /\b(sign ?on bonus|signon bonus|reclass|bonus)\b/g;

/** Que forma tiene esta descripcion, y por tanto cuanto nos fiamos de ella. */
export type DescriptionShape =
  /** "APELLIDO, NOMBRE" — el 96% del dinero. */
  | "comma"
  /** Lleva un correo de la casa: su local part ES el person_code. */
  | "email"
  /** "ZOOMPLUS-Frank Rodriguez", "SAFE COURSE - Stephanie Garcia". */
  | "prefixed"
  /** "SALESFORCE USER FOR BALLON, MARIO". */
  | "for"
  /** Alquiler, publicidad, coste de sucursal. No es de nadie. */
  | "none";

/** Las dos formas que suman en el total. Las otras se muestran aparte. */
export const SHAPES_IN_TOTAL: readonly DescriptionShape[] = ["comma", "email"];

export interface ParsedDescription {
  shape: DescriptionShape;
  /** La clave normalizada, cuando la forma da una. */
  key: NameKey | null;
  /** El local part del correo, que es un person_code. Solo en shape "email". */
  personCode: string | null;
  /**
   * La descripcion llegaba en el limite de 35 caracteres, asi que el nombre
   * puede venir cortado. No descalifica la fila: la manda a la via que exige
   * candidato unico.
   */
  truncated: boolean;
}

const LARGO_TRUNCADO = 35;

/**
 * El person_code dentro de un correo de la casa.
 *
 * ⚠ EXIGE AL MENOS UN PUNTO, y no es capricho. La primera version aceptaba
 * guiones en el local part --que un correo de verdad admite-- y en
 * "ZoomPlus-stephanie.garcia@supremele" se tragaba el prefijo entero:
 * devolvia "zoomplus-stephanie.garcia", que no es el codigo de nadie. La fila
 * quedaba sin atribuir y parecia que la persona no tenia ese gasto.
 *
 * Todos los person_code de la division son "algo.algo" --jose.arango,
 * m.rodriguez, c.velasco, haydee.titopace--, asi que pedir el punto ancla el
 * comienzo del codigo sin depender de por donde empiece el prefijo. Si algun
 * dia hubiera un codigo sin punto, esta forma no lo vera y la fila caera a las
 * otras vias en vez de resolverse mal.
 */
const EMAIL = /([a-z0-9]+(?:\.[a-z0-9]+)+)@/i;

/**
 * De una `check_description` a lo que se pueda sacar de ella.
 *
 * El orden importa y es por fiabilidad, no por frecuencia: el correo primero
 * porque no se parece a un person_code sino que lo es; la coma despues porque
 * lleva casi todo el dinero.
 */
export function parseDescription(raw: string | null | undefined): ParsedDescription {
  const vacio: ParsedDescription = { shape: "none", key: null, personCode: null, truncated: false };
  if (!raw) return vacio;

  const texto = raw.trim();
  const truncated = texto.length >= LARGO_TRUNCADO;

  const email = texto.match(EMAIL);
  if (email) {
    // Un correo cortado a 35 caracteres pierde el dominio, no el local part:
    // "ZoomPlus-stephanie.garcia@supremele" sigue diciendo quien es.
    return { shape: "email", key: null, personCode: email[1].toLowerCase(), truncated };
  }

  // "04/26 SUN LIFE - LAINO CHEGWIN, GIA" -> lo de despues del ultimo " - ".
  const corte = texto.lastIndexOf(" - ");
  const sinPrefijo = corte >= 0 ? texto.slice(corte + 3) : texto;

  if (sinPrefijo.includes(",")) {
    const coma = sinPrefijo.indexOf(",");
    const apellidos = normalizeName(sinPrefijo.slice(0, coma));
    // La inicial del segundo nombre sobra: "GIAN L" y "GIAN" son la misma
    // persona, y la inicial no aparece en ninguna fuente canonica.
    const nombres = normalizeName(sinPrefijo.slice(coma + 1)).replace(/ [a-z]$/, "");
    const key = normalizeName(`${nombres} ${apellidos}`.replace(CONCEPTOS_INCRUSTADOS, " "));
    if (!key || !apellidos || !nombres) return { ...vacio, truncated };
    // "SALESFORCE USER FOR BALLON, MARIO" tambien tiene coma, pero su apellido
    // sale contaminado con "salesforce user for". Se manda a la via fragil.
    if (/\b(for|user|salesforce)\b/.test(apellidos)) {
      return { shape: "for", key, personCode: null, truncated };
    }
    return { shape: "comma", key, personCode: null, truncated };
  }

  // "ZOOMPLUS-FRANK RODRIGUEZ", "SAFE COURSE - Stephanie Garcia": nombre de pila
  // primero y sin coma. Se reconoce pero NO entra en el total.
  const cola = corte >= 0 ? sinPrefijo : texto.replace(/^[A-Z0-9 ]+[-_]/, "");
  const key = normalizeName(cola);
  if (key && key.split(" ").length >= 2 && key !== normalizeName(texto)) {
    return { shape: "prefixed", key, personCode: null, truncated };
  }

  return { ...vacio, truncated };
}

/** Una persona conocida, con todas las grafias por las que se la puede nombrar. */
export interface KnownPerson {
  /** Canonico cuando se conoce. Null para quien solo existe en loan_officials. */
  personCode: string | null;
  /** Como se muestra. */
  displayName: string;
  /** Todas sus grafias ya normalizadas. */
  keys: readonly NameKey[];
}

export type MatchMethod =
  /** Igualdad de clave. */
  | "exact"
  /** El correo dio el person_code directamente. */
  | "email"
  /** Una grafia conocida es prefijo de tokens de la del P&L, o al reves. */
  | "contained"
  /**
   * Coinciden el primer y el ultimo token, ignorando los del medio.
   *
   * Es lo que resuelve "Adriana Julieth Szczech" contra "adriana szczech" y
   * "Julymar Mar Castro" contra "julymar castro": un nombre intermedio que una
   * fuente escribe y otra no. Medido sobre las 111 personas de dim_person: cero
   * ambiguedades.
   *
   * ⚠ MIRA LOS DOS EXTREMOS Y NADA MAS, Y ESE LIMITE ES DELIBERADO. La
   * tentacion al leer esto es generalizar --"que tolere cualquier token
   * intermedio"-- y ahi es justo donde se rompe: una heuristica de texto no
   * distingue un segundo nombre de una particula de apellido.
   *
   * El caso que lo decide es Hortencia De Anda. "De Anda" es un apellido
   * compuesto, no un nombre intermedio: quedarse con los extremos da
   * "hortencia anda", que no es el apellido de nadie. Aqui no hace daño
   * --no casa con nadie, la fila cae a "sin localizar" y eso es honesto--
   * pero enseña que la regla no entiende lo que mira. Con De, Del, La, Van o
   * Mac el patron reaparece, y en esta plantilla reaparece seguido.
   *
   * Por eso los extremos y no el medio: son la unica parte del nombre que
   * ninguna fuente reordena ni abrevia. Ampliar la regla exigiria saber cual
   * de los tokens es apellido, y eso no se deduce del texto -- se le pregunta
   * al origen, que es para lo que existe `hr_centralizado.person_name_key`.
   * Una grafia que falte se añade alli, no se adivina aqui.
   *
   * ⚠ LO DE "CERO AMBIGUEDADES" ES DE ESTA POBLACION, NO UNA GARANTIA DEL
   * METODO. Medido el 2026-09-14 sobre las 111 personas y las 523 grafias de
   * `org.person_name_key`: emparejar por primer y ultimo token no funde a
   * nadie, cero colisiones. Pero eso es una propiedad de 111 personas. Con el
   * doble de gente, dos "maria ... rodriguez" distintas colisionan y nada
   * avisa. Si algun dia esta via empieza a dar ambiguos, no es un fallo
   * nuevo: es esta medicion caducando, y toca rehacerla ANTES de tocar la
   * regla, no despues.
   */
  | "ends";

export interface MatchResult {
  person: KnownPerson | null;
  method: MatchMethod | null;
  /** Mas de un candidato: no se elige ninguno. Se pinta como ambiguo. */
  ambiguous: boolean;
  /** Los nombres de los candidatos cuando hay empate, para poder enseñarlos. */
  candidates: readonly string[];
}

const SIN_MATCH: MatchResult = { person: null, method: null, ambiguous: false, candidates: [] };

function tokens(k: NameKey): string[] {
  return k ? k.split(" ") : [];
}

/** ¿Una clave contiene a la otra por tokens completos, en orden? */
function contiene(a: NameKey, b: NameKey): boolean {
  return a.startsWith(`${b} `) || b.startsWith(`${a} `);
}

/** ¿Coinciden primer y ultimo token? */
function mismosExtremos(a: NameKey, b: NameKey): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length < 2 || tb.length < 2) return false;
  return ta[0] === tb[0] && ta[ta.length - 1] === tb[tb.length - 1];
}

/**
 * Resuelve una descripcion del P&L contra el censo de personas conocidas.
 *
 * Las vias se prueban de mas a menos fuerte y SE PARA EN LA PRIMERA QUE DA
 * EXACTAMENTE UNA PERSONA. Que una via mas debil encontrara luego otro candidato
 * no invalida un acierto exacto: son reglas ordenadas, no votos.
 */
export function matchDescription(
  parsed: ParsedDescription,
  people: readonly KnownPerson[],
): MatchResult {
  if (parsed.shape === "email" && parsed.personCode) {
    const p = people.find((x) => x.personCode === parsed.personCode);
    // Un person_code que no esta en el censo no es un empate: es alguien de
    // fuera de la division, y decirlo es mas util que callarlo.
    return p ? { person: p, method: "email", ambiguous: false, candidates: [] } : SIN_MATCH;
  }

  const key = parsed.key;
  if (!key) return SIN_MATCH;

  const vias: { method: MatchMethod; test: (k: NameKey) => boolean }[] = [
    { method: "exact", test: (k) => k === key },
    { method: "contained", test: (k) => contiene(k, key) },
    { method: "ends", test: (k) => mismosExtremos(k, key) },
  ];

  for (const via of vias) {
    const hits = people.filter((p) => p.keys.some(via.test));
    if (hits.length === 1) {
      return { person: hits[0], method: via.method, ambiguous: false, candidates: [] };
    }
    if (hits.length > 1) {
      // Se para aqui a proposito. Bajar a una via mas laxa despues de un empate
      // solo puede empeorarlo, y elegir uno seria inventarse el dato.
      return {
        person: null,
        method: null,
        ambiguous: true,
        candidates: hits.map((h) => h.displayName),
      };
    }
  }

  return SIN_MATCH;
}

/**
 * Pares de loan officers que el origen resuelve a la MISMA persona.
 *
 * Nace de Galo Rizzo y Galo Rizzo Hinojosa: `person_name_key` manda los dos a
 * `galo.rizzo`, y `loan_officials` los tiene como dos filas distintas, una con
 * un solo cierre. Quien lea la pantalla sin saberlo lee mal las cifras de los
 * dos.
 *
 * ⚠ ES UNA AFIRMACION VERIFICABLE, NO UNA SOSPECHA POR APELLIDO. No dice "estos
 * dos se parecen": dice que el origen los resuelve al mismo person_code y que
 * aqui estan separados. Por eso se deriva del dato y no de una lista, y por eso
 * aparecera sola el dia que haya otro par -- sin que nadie tenga que acordarse.
 *
 * Se corrige en BigQuery, no aqui: unirlos en esta app taparia el defecto del
 * origen y dejaria a las otras pantallas partidas igual.
 */
export interface CollapsedPair {
  personCode: string;
  /** Los nombres que loan_officials tiene separados. */
  names: readonly string[];
}

export function findCollapsedPairs(
  officers: readonly { name: string; personCode: string | null }[],
): CollapsedPair[] {
  const porCodigo = new Map<string, string[]>();
  for (const o of officers) {
    if (!o.personCode) continue;
    const lista = porCodigo.get(o.personCode) ?? [];
    if (!lista.includes(o.name)) lista.push(o.name);
    porCodigo.set(o.personCode, lista);
  }
  return [...porCodigo.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([personCode, names]) => ({ personCode, names: names.sort() }));
}
