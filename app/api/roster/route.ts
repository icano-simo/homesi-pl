import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import {
  GRUPO_ROSTER_EN_EL_ARCHIVO,
  NO_SON_PERSONAS,
  cargoDelArchivo,
  clavePrimeroUltimo,
  normalizar,
  sucursalDelArchivo,
} from "@/lib/roster-file";

export const dynamic = "force-dynamic";

const MESES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

/** year*100 + mes, para poder comparar periodos con un `<`. */
function periodoDe(year: number | null, month: string | null): number | null {
  if (year == null || !month) return null;
  const i = MESES.indexOf(month);
  return i < 0 ? null : year * 100 + i + 1;
}

function etiquetaDePeriodo(p: number): string {
  return `${MESES[(p % 100) - 1]} ${Math.floor(p / 100)}`;
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * UNA FILA POR PERSONA. SIEMPRE.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ EL GRANO NO CAMBIA AL FILTRAR, y es la decision de diseño de todo el
 * modulo. Al acotar una sucursal se recorta la COLUMNA de sucursales de cada
 * persona y desaparece quien no tenga ninguna; nadie se parte en dos filas.
 *
 * El grano persona-sucursal existe para no duplicar importes, y aqui no hay
 * importes: lo unico que compraria es que 23 de las 140 personas salieran dos o
 * tres veces con el mismo contenido. Un listado de personas con 23 nombres
 * repetidos se lee como un error de datos, y ademas hace que el conteo de filas
 * baile segun el filtro.
 */
export interface RosterPerson {
  /** `person_code` cuando se sabe; si no, el nombre normalizado del archivo. */
  key: string;
  name: string;
  personCode: string | null;
  /** Ordenadas. Del archivo cuando esta en el; del roster cuando no. */
  branches: string[];
  /** El que se enseña. Null solo cuando no hay ninguno o no se pudo elegir. */
  position: string | null;
  positionSource: "roster" | "file" | null;
  /** Lo que dice el archivo, guardado siempre. NO es un historial de ascensos. */
  positionInFile: string | null;
  /** Quedan dos valores y ninguna regla los separa: se enseñan crudos. */
  positionAmbiguous: boolean;
  positionRaw: string[];
  inRoster: boolean;
  inFile: boolean;
  country: string | null;

  /**
   * ⚠ QUIEN NO COBRA, NO ESTA -- Y EL ROSTER DE RR.HH. NO LO SABE.
   *
   * Medido el 2026-09-18: `org.roster_current` tiene 115 personas, 111
   * marcadas activas y **CERO** con `left_detected_at`. Ninguna baja
   * registrada, nunca. Mientras tanto el archivo de nomina enseña 16 que
   * dejaron de cobrar, dos de ellas confirmadas por el usuario como salidas
   * --John Bedoya y Walter Serrano--.
   *
   * Asi que el estado NO sale del roster: sale de si la persona aparece en el
   * ultimo mes cargado del archivo. El hallazgo completo, las 16 y por que no
   * son 18, en docs/el-roster-no-registra-bajas.md.
   *
   *   active     cobro en el ultimo mes cargado
   *   inactive   esta en el archivo y dejo de aparecer. `lastPaid` dice cuando
   *   unknown    no esta en el archivo, asi que esta regla no le aplica
   *
   * ⚠ "unknown" NO ES "active", y es la distincion que hace util a la columna.
   * Son 70 personas, entre ellas las 68 de EE.UU., que no salen en el archivo
   * de offshore y para las que NO HAY DATO de si siguen. Pintarlas activas
   * diria que se comprobo, y no se ha comprobado nada.
   */
  status: "active" | "inactive" | "unknown";
  /** El ultimo mes en que cobro, con nombre. Null si no esta en el archivo. */
  lastPaid: string | null;
}

export interface RosterResult {
  people: RosterPerson[];
  branches: string[];
  counts: {
    total: number; inBoth: number; onlyRoster: number; onlyFile: number;
    inactive: number; unknown: number;
  };
  /**
   * El ultimo mes cargado del archivo, DERIVADO DEL DATO.
   *
   * ⚠ NO SE ESCRIBE EN NINGUN SITIO. Es el maximo periodo que trae el archivo,
   * asi que el dia que entre octubre la regla se mueve sola y nadie tiene que
   * acordarse de tocar una constante. Una fecha a mano aqui seria una bomba de
   * relojeria: seguiria dando por activos a los de septiembre para siempre.
   */
  lastLoadedMonth: string | null;
  /**
   * Lo que dice el roster de RR.HH. sobre si mismo.
   *
   * ⚠ SE DEVUELVE PARA QUE LA PANTALLA NO LO ESCRIBA A MANO. El hallazgo --111
   * activas de 115 y CERO bajas registradas-- es la razon de que el estado
   * salga de la nomina y no de aqui, y una frase con numeros fijos deja de ser
   * cierta en cuanto RR.HH. toque algo, sin que nada avise.
   */
  hrRoster: { total: number; active: number; withLeftDate: number };
  /** De los "unknown", cuantos son de EE.UU. Tambien derivado. */
  unknownUS: number;
  /** Fuentes que no respondieron. Una lista vacia es lo normal. */
  notes: string[];
}

export async function GET(req: NextRequest) {
  const fd = createServerClient();
  const org = createServerClient("org");
  const wanted = new URL(req.url).searchParams.getAll("branch").filter(Boolean);
  const notes: string[] = [];

  /*
   * ── 1. El archivo ─────────────────────────────────────────────────────────
   *
   * Solo el grupo que es gente. Los vendors ya viven en el modulo de Vendors
   * por su columna `vendor`, y las 15 de "Homesi ... payroll" son nomina
   * agregada. El porque, en lib/roster-file.ts.
   */
  const filas: {
    nombre: string; sucursal: string | null; cargo: string | null;
    periodo: number | null;
  }[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await fd
      .from("pl_transactions")
      .select("check_description_3,branch_allocation,position,year,month")
      .eq("source", "offshore_allocations")
      .eq("check_description_2", GRUPO_ROSTER_EN_EL_ARCHIVO)
      .order("id", { ascending: true })
      .range(offset, offset + 999);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;
    for (const r of data) {
      const nombre = (r.check_description_3 ?? "").trim();
      if (!nombre || NO_SON_PERSONAS.has(nombre)) continue;
      filas.push({
        nombre,
        sucursal: sucursalDelArchivo(r.branch_allocation),
        cargo: r.position,
        periodo: periodoDe(r.year, r.month),
      });
    }
    if (data.length < 1000) break;
  }

  /*
   * ── 2. El roster: la identidad, y la sucursal de quien no esta en el archivo ─
   *
   * Si `org` no responde, el modulo sigue: se queda con el archivo y lo dice.
   * Callarlo pintaria 70 personas menos como si no existieran.
   */
  type RosterRow = {
    person_code: string; display_name: string | null;
    branch_code: string | null; position: string | null; country: string | null;
    is_active: boolean | null; left_detected_at: string | null;
  };
  let roster: RosterRow[] = [];
  try {
    const { data, error } = await org
      .from("roster_current")
      .select("person_code,display_name,branch_code,position,country,is_active,left_detected_at")
      .range(0, 999);
    if (error) throw new Error(error.message);
    roster = (data ?? []) as RosterRow[];
  } catch (e) {
    notes.push(`org.roster_current no disponible (${e instanceof Error ? e.message : "?"})`);
  }

  /*
   * ── 3. Emparejar ──────────────────────────────────────────────────────────
   *
   * Dos claves, y la segunda SOLO si es unica: el archivo escribe segundos
   * nombres que el roster no tiene. Sin la guarda, dos personas con el mismo
   * nombre y apellido se funden -- el error que lib/lo-payroll-name.ts ya
   * documenta y que aqui seria invisible.
   */
  const porNombre = new Map<string, string>();
  const porPrimeroUltimo = new Map<string, string[]>();
  let nameKeys: { person_code: string; name_key: string }[] = [];
  try {
    const { data, error } = await org
      .from("person_name_key")
      .select("person_code,name_key")
      .range(0, 999);
    if (error) throw new Error(error.message);
    nameKeys = (data ?? []) as typeof nameKeys;
  } catch {
    notes.push("org.person_name_key no disponible: bajan los emparejamientos");
  }

  const enRoster = new Set(roster.map((r) => r.person_code));
  const alias: { code: string; texto: string }[] = [
    ...nameKeys.map((n) => ({ code: n.person_code, texto: n.name_key })),
    ...roster.map((r) => ({ code: r.person_code, texto: r.display_name ?? "" })),
  ];
  for (const a of alias) {
    if (!a.texto || !enRoster.has(a.code)) continue;
    const k = normalizar(a.texto);
    if (!porNombre.has(k)) porNombre.set(k, a.code);
    const pu = clavePrimeroUltimo(a.texto);
    if (pu) {
      const l = porPrimeroUltimo.get(pu) ?? [];
      if (!l.includes(a.code)) l.push(a.code);
      porPrimeroUltimo.set(pu, l);
    }
  }
  const resolver = (nombre: string): string | null => {
    const exacto = porNombre.get(normalizar(nombre));
    if (exacto) return exacto;
    const pu = clavePrimeroUltimo(nombre);
    if (!pu) return null;
    const cand = porPrimeroUltimo.get(pu);
    // La guarda: un solo candidato o nada.
    return cand && cand.length === 1 ? cand[0] : null;
  };

  /*
   * ── 4. Una fila por persona ───────────────────────────────────────────────
   *
   * La clave es el `person_code` cuando se sabe, y por eso las dos formas de
   * escribir a Jimena Ferrer Gutierrez caen en la misma fila.
   */
  type Acc = {
    name: string; personCode: string | null;
    branches: Set<string>; cargosArchivo: (string | null)[];
    inFile: boolean; inRoster: boolean;
    /** El periodo mas alto en que esta persona aparece en el archivo. */
    ultimoPeriodo: number | null;
  };
  const gente = new Map<string, Acc>();

  for (const f of filas) {
    const code = resolver(f.nombre);
    const key = code ?? `file:${normalizar(f.nombre)}`;
    const a = gente.get(key) ?? {
      name: f.nombre, personCode: code,
      branches: new Set<string>(), cargosArchivo: [],
      inFile: true, inRoster: code != null,
      ultimoPeriodo: null,
    };
    // El nombre mas largo del archivo, que es el que trae el segundo nombre.
    if (f.nombre.length > a.name.length) a.name = f.nombre;
    if (f.sucursal) a.branches.add(f.sucursal);
    a.cargosArchivo.push(f.cargo);
    /*
     * ⚠ SE ACUMULA POR PERSONA YA UNIFICADA, NO POR TEXTO. Es la diferencia
     * entre 16 bajas y 17: "Jimena Ferrer Gutierrez" deja de aparecer en junio
     * y "Jimena Ines Ferrer Gutierrez" cobra hasta septiembre. Son la misma
     * persona --`jimena.ferrer`-- y NO es una baja. Comparando el texto crudo
     * lo seria, y saldria en la lista con nombre y apellidos.
     */
    if (f.periodo != null && (a.ultimoPeriodo == null || f.periodo > a.ultimoPeriodo)) {
      a.ultimoPeriodo = f.periodo;
    }
    gente.set(key, a);
  }

  for (const r of roster) {
    const a = gente.get(r.person_code);
    if (a) { a.inRoster = true; continue; }
    gente.set(r.person_code, {
      name: r.display_name ?? r.person_code,
      personCode: r.person_code,
      // Sin filas en el archivo, la sucursal es la del roster.
      branches: new Set(r.branch_code ? [r.branch_code.toUpperCase()] : []),
      cargosArchivo: [], inFile: false, inRoster: true,
      ultimoPeriodo: null,
    });
  }

  /*
   * El ultimo mes cargado: el maximo del archivo, no una fecha escrita.
   * Si el archivo estuviera vacio no hay regla que aplicar y todos quedan en
   * "unknown", que es lo honesto: sin archivo no se sabe quien sigue.
   */
  const ultimoCargado = filas.reduce<number | null>(
    (max, f) => (f.periodo != null && (max == null || f.periodo > max) ? f.periodo : max),
    null,
  );

  const porCodigo = new Map(roster.map((r) => [r.person_code, r]));
  const people: RosterPerson[] = [...gente.entries()].map(([key, a]) => {
    const rr = a.personCode ? porCodigo.get(a.personCode) : undefined;
    const delArchivo = cargoDelArchivo(a.cargosArchivo);
    /* Manda el roster cuando la persona esta en el; el archivo cuando no. */
    const position = rr?.position ?? delArchivo.cargo;
    return {
      key,
      name: rr?.display_name ?? a.name,
      personCode: a.personCode,
      branches: [...a.branches].sort(),
      position,
      positionSource: position == null ? null : rr?.position ? "roster" : "file",
      positionInFile: delArchivo.cargo,
      /* Marcado solo cuando NADIE puede dar el cargo: con roster no estorba. */
      positionAmbiguous: delArchivo.ambiguo && !rr?.position,
      positionRaw: delArchivo.crudos,
      inRoster: a.inRoster,
      inFile: a.inFile,
      country: rr?.country ?? null,
      status:
        a.ultimoPeriodo == null || ultimoCargado == null
          ? "unknown"
          : a.ultimoPeriodo >= ultimoCargado
            ? "active"
            : "inactive",
      lastPaid: a.ultimoPeriodo == null ? null : etiquetaDePeriodo(a.ultimoPeriodo),
    };
  });

  const branches = [...new Set(people.flatMap((p) => p.branches))].sort();

  /*
   * ⚠ EL FILTRO RECORTA LA COLUMNA, NO PARTE LA FILA. Quien no tenga ninguna
   * de las sucursales pedidas desaparece; quien tenga tres y encaje por una
   * sigue siendo UNA fila, enseñando solo la que encaja.
   *
   * ⚠ Y POR ESO LAS SUCURSALES NO PARTICIONAN A LA GENTE. Sumadas una a una
   * dan 164 sobre 139 personas: las 23 que sirven a varias cuentan en cada una
   * de las suyas. No es un doble conteo a corregir --nadie lleva importe-- pero
   * sumar las sucursales para sacar la plantilla da un numero falso. Es el mismo
   * aviso que las lentes del P&L, al reves: alli la particion es la promesa,
   * aqui la pertenencia multiple es el dato.
   */
  const visibles = wanted.length === 0
    ? people
    : people
        .filter((p) => p.branches.some((b) => wanted.includes(b)))
        .map((p) => ({ ...p, branches: p.branches.filter((b) => wanted.includes(b)) }));

  visibles.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  const res: RosterResult = {
    people: visibles,
    branches,
    counts: {
      total: visibles.length,
      inBoth: visibles.filter((p) => p.inRoster && p.inFile).length,
      onlyRoster: visibles.filter((p) => p.inRoster && !p.inFile).length,
      onlyFile: visibles.filter((p) => !p.inRoster && p.inFile).length,
      inactive: visibles.filter((p) => p.status === "inactive").length,
      unknown: visibles.filter((p) => p.status === "unknown").length,
    },
    lastLoadedMonth: ultimoCargado == null ? null : etiquetaDePeriodo(ultimoCargado),
    hrRoster: {
      total: roster.length,
      active: roster.filter((r) => r.is_active).length,
      withLeftDate: roster.filter((r) => r.left_detected_at != null).length,
    },
    unknownUS: visibles.filter((p) => p.status === "unknown" && p.country === "US").length,
    notes,
  };
  return NextResponse.json(res);
}
