/**
 * ─────────────────────────────────────────────────────────────────────────────
 * PRUEBA DEL EMPAREJADOR DE NOMBRES DE NOMINA  (lib/lo-payroll-name.ts)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * COMO SE CORRE (este repo no tiene runner de pruebas; no hace falta instalar
 * ninguno, el compilador ya esta):
 *
 *     npx tsc lib/lo-payroll-name.ts --outDir .tmp-test --target es2022 \
 *         --module es2022 --moduleResolution bundler --lib es2022
 *     node scripts/verificacion/lo-payroll-name.test.mjs
 *
 * El tsc imprime errores de @types/react-dom que no vienen al caso --compila un
 * archivo suelto sin el tsconfig del proyecto-- y aun asi emite el .js. Se
 * ignoran: si el archivo tuviera un error de verdad, no habria salida y el node
 * de abajo fallaria al importar.
 *
 * ⚠ NINGUNA CADENA DE AQUI ESTA INVENTADA. Todas salieron de una consulta a
 * finance_division.pl_transactions. Esa es la unica razon por la que esta prueba
 * vale algo: un caso inventado prueba que el codigo hace lo que el autor creia,
 * no que aguante los datos.
 *
 * Y ya pago: cazo que el regex del correo se tragaba el prefijo entero en
 * "ZoomPlus-stephanie.garcia@supremele" y devolvia "zoomplus-stephanie.garcia".
 * Leyendo el codigo se veia bien.
 */
import { parseDescription, matchDescription, normalizeName, findCollapsedPairs }
  from "../../.tmp-test/lo-payroll-name.js";

let fallos = 0;
const ok = (c, msg) => { if (!c) { console.log("  FALLO: " + msg); fallos++; } };

// ── 1. Que forma tiene cada descripcion real, y que clave sale ──────────────
console.log("1. formas");
for (const [txt, forma, clave] of [
  ["LAINO CHEGWIN, GIAN L",                 "comma",    "gian laino chegwin"],
  // El guion y el espacio tienen que dar la MISMA clave: son la misma persona
  // escrita de dos maneras en dos cuentas distintas.
  ["RAMIREZ-DAZA, CRISTHIAN A",             "comma",    "cristhian ramirez daza"],
  ["11/25 SUN LIFE - RAMIREZ DAZA, CRIS",   "comma",    "cris ramirez daza"],
  ["ZEGARRA, ANA M",                        "comma",    "ana zegarra"],
  // Las dos Castro: el caso por el que se descarto emparejar por parecido.
  ["CASTRO, JUSETH M",                      "comma",    "juseth castro"],
  ["06/26 DENTAL - CASTRO, JULY",           "comma",    "july castro"],
  // Con inicial y sin ella.
  ["BADOVINAC, STEVEN P",                   "comma",    "steven badovinac"],
  ["11/25 MEDICAL - BADOVINAC, STEVEN",     "comma",    "steven badovinac"],
  // Mayusculas y minusculas, que la contabilidad mezcla en la misma cuenta.
  ["Arango, Jose M",                        "comma",    "jose arango"],
  ["ARANGO, JOSE M",                        "comma",    "jose arango"],
  // Tiene coma, pero el apellido sale contaminado: a la via fragil.
  ["SALESFORCE USER FOR BALLON, MARIO",     "for",      null],
  ["ZOOMPLUS-FRANK RODRIGUEZ",              "prefixed", "frank rodriguez"],
  ["SAFE COURSE - Stephanie Garcia",        "prefixed", "stephanie garcia"],
  // Las 131 filas que descuadraban 64100: no son la nomina de nadie.
  ["NOV 2025 ACCOUNTING FEE",               "none",     null],
  ["30% SHA",                               "none",     null],
]) {
  const p = parseDescription(txt);
  ok(p.shape === forma, `${txt} -> ${p.shape}, esperaba ${forma}`);
  if (clave) ok(p.key === clave, `${txt} -> clave ${p.key}, esperaba ${clave}`);
}

// ── 2. El correo da person_code, no un nombre ───────────────────────────────
console.log("2. email");
for (const [txt, code] of [
  ["ZoomPlus-stephanie.garcia@supremele", "stephanie.garcia"],
  ["ZOOMPLUS-M.RODRIGUEZ@SUPREMELENDING", "m.rodriguez"],
  ["ZoomPlus-jose.arango@supremelending", "jose.arango"],
]) {
  const p = parseDescription(txt);
  ok(p.shape === "email", `${txt} -> ${p.shape}`);
  ok(p.personCode === code, `${txt} -> ${p.personCode}, esperaba ${code}`);
}

const censo = [
  { personCode: "julymar.castro",  displayName: "Julymar Castro",
    keys: ["julymar castro", "july castro"] },
  { personCode: "juseth.castro",   displayName: "Juseth Castro",   keys: ["juseth castro"] },
  { personCode: "steve.badovinac", displayName: "Steve Badovinac",
    keys: ["steve badovinac", "steven badovinac"] },
  { personCode: "c.velasco",       displayName: "Claudia Velasco", keys: ["claudia velasco"] },
  { personCode: "adriana.espinoza", displayName: "Adriana Szczech", keys: ["adriana szczech"] },
  { personCode: "stephanie.garcia", displayName: "Stephanie Garcia", keys: ["stephanie garcia"] },
];

// ── 3. Las dos Castro no se funden ──────────────────────────────────────────
console.log("3. las dos Castro");
ok(matchDescription(parseDescription("06/26 DENTAL - CASTRO, JULY"), censo).person?.personCode
   === "julymar.castro", "July debe ser julymar.castro");
ok(matchDescription(parseDescription("CASTRO, JUSETH M"), censo).person?.personCode
   === "juseth.castro", "Juseth debe ser juseth.castro");

// ── 4. Cada via, por separado ───────────────────────────────────────────────
console.log("4. vias");
const via = (txt) => { const r = matchDescription(parseDescription(txt), censo);
                       return `${r.method ?? "-"}:${r.person?.personCode ?? "-"}`; };
ok(via("BADOVINAC, STEVEN P") === "exact:steve.badovinac", via("BADOVINAC, STEVEN P"));
ok(via("VELASCO-PEREZ, CLAUDIA X") === "contained:c.velasco", via("VELASCO-PEREZ, CLAUDIA X"));
ok(via("ZoomPlus-stephanie.garcia@supremele") === "email:stephanie.garcia",
   via("ZoomPlus-stephanie.garcia@supremele"));

// Primer y ultimo token: lo unico que resuelve "Adriana Julieth Szczech"
// contra la grafia "adriana szczech".
const ends = matchDescription(
  { shape: "comma", key: normalizeName("adriana julieth szczech"), personCode: null,
    truncated: false }, censo);
ok(ends.method === "ends" && ends.person?.personCode === "adriana.espinoza",
   `szczech -> ${ends.method}:${ends.person?.personCode}`);

// ── 5. Un fragmento truncado NO elige persona ───────────────────────────────
//
// Es LA propiedad que hace segura toda la regla. "CASTRO, JU" truncado a 35
// caracteres podria ser Julymar o Juseth, que son dos personas distintas y las
// dos cobran. Emparejar por prefijo asignaria el dinero de una a la otra sin
// que nada lo delatara.
//
// ⚠ Y SALE "sin localizar", NO "ambiguo". Se comprobo y es correcto: ninguna de
// las tres vias llega a producir candidatos --ni "ju castro" ni "castro" son
// prefijo de token completo de nadie, ni comparten primer token--, asi que no
// hay empate que declarar. "Ambiguo" queda para cuando dos personas SI compiten
// por la misma clave. Las dos se pintan distinto de cero, que es lo que importa.
console.log("5. un truncado no elige");
for (const fragmento of ["ju castro", "castro"]) {
  const r = matchDescription(
    { shape: "comma", key: fragmento, personCode: null, truncated: true }, censo);
  ok(r.person === null, `"${fragmento}" no debe elegir persona, eligio ${r.person?.personCode}`);
}

// ── 6. Pares que el origen colapsa y loan_officials tiene separados ─────────
console.log("6. pares colapsados");
const pares = findCollapsedPairs([
  { name: "Galo Rizzo", personCode: "galo.rizzo" },
  { name: "Galo Rizzo Hinojosa", personCode: "galo.rizzo" },
  { name: "Luis Silva", personCode: "luis.silva" },
  // Sin person_code no se puede afirmar nada: no debe inventar un par.
  { name: "Brian Heibel", personCode: null },
]);
ok(pares.length === 1, `esperaba 1 par, hay ${pares.length}`);
ok(pares[0]?.personCode === "galo.rizzo", "el par debe ser galo.rizzo");
ok(pares[0]?.names.length === 2, "el par debe tener dos nombres");

console.log(fallos === 0 ? "\nTODO OK" : `\n${fallos} FALLOS`);
process.exit(fallos === 0 ? 0 : 1);
