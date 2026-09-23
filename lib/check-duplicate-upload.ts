// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

export type DuplicateInfo = {
  upload_id: string;
  file_name: string;
  uploaded_at: string;
  row_count: number | null;
  overlap: string[]; // e.g. ["January 2025", "February 2025"]
  /**
   * TODOS los periodos que contiene el upload, no solo los que solapan.
   *
   * ⚠ ES LO QUE SE VA A BORRAR, y esa es la diferencia que importa. `overlap`
   * dice en que se pisa con el archivo nuevo; esto dice cuanto se lleva por
   * delante el Replace. Un upload puede solapar en UN mes y contener ONCE.
   */
  periods: string[];
  /** Cuantas filas tiene de verdad, contadas y no estimadas. */
  rows: number;
  /**
   * Asignaciones manuales que el Replace intentara reaplicar.
   *
   * No se pierden sin mas --hay respaldo y reaplicacion-- pero las que no
   * vuelvan a cruzar quedan para revisar, asi que el numero es lo que dice
   * cuanto trabajo hay detras de ese boton.
   */
  manualAssignments: number;
};

export type DuplicateCheckResult =
  | { found: false }
  /**
   * ⚠ DEVUELVE TODOS LOS CANDIDATOS, NO EL "MEJOR".
   *
   * Antes elegia uno --el que mas filas solapaba-- y la pantalla enseñaba solo
   * su nombre. Con varios candidatos eso descarta los demas en silencio, y el
   * nombre de un archivo no dice lo que hay dentro: "kelly.ovalle
   * 27072026120837383.xlsx" son 11.092 filas de ONCE meses con 571 asignaciones
   * manuales, y nada en ese nombre lo insinua.
   */
  | { found: true; candidates: DuplicateInfo[] };

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠ ESTA COMPROBACION ES DE PERIODOS. NO INTENTES HACERLA FILA A FILA.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Solapar un periodo NO es duplicar. Dos uploads pueden cubrir el mismo mes y
 * ser correctos: medido el 2026-09-23, el P&L reparte los meses POR SUCURSAL
 * --un archivo trae 17 sucursales, otro añade la 728 y la 733-- y de once
 * periodos compartidos solo uno comparte ademas sucursal, con filas distintas.
 *
 * ⚠ Y COMPARAR FILAS POR SU CONTENIDO NO PRUEBA DUPLICACION EN `offshore_
 * allocations`. Sus filas NO LLEVAN FECHA NI DESCRIPCION, asi que (persona,
 * cuenta, importe) iguales es exactamente lo que produce una NOMINA
 * QUINCENAL: dos quincenas del mismo sueldo son indistinguibles de una fila
 * cargada dos veces.
 *
 * Esto no es hipotetico. El 2026-09-23 esa firma señalo 16 "duplicados" de
 * enero --16 personas, -14.586,93-- y eran legitimos: dos quincenas cada uno.
 * Se borraron y hubo que reponerlos. El criterio parecia concluyente y no lo
 * era, que es la familia de errores de
 * docs/el-agregado-no-verifica-las-partes.md.
 *
 * En `original` la misma firma SI discrimina, porque ahi hay `ref_numb` y
 * `check_description`. Que funcione en una fuente no dice nada de la otra: son
 * dos granos distintos con el mismo nombre.
 *
 * LO QUE SI SE PUEDE AFIRMAR es que un ARCHIVO ENTERO ya se subio -- mismo
 * nombre o mismo hash. Eso no depende de que las filas sean distinguibles.
 * Ver `findSameFile`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Checks whether an existing upload of the same source type covers any of the
 * same month+year combinations as the rows being uploaded now.
 * Returns the most-overlapping existing upload if found.
 */
export async function checkDuplicateUpload(
  supabase: SupabaseClient,
  source: "original" | "addback" | "offshore_allocations",
  rows: Array<{ month: string | null; year: number | null }>
): Promise<DuplicateCheckResult> {
  const months = [...new Set(rows.map((r) => r.month).filter(Boolean))] as string[];
  const years  = [...new Set(rows.map((r) => r.year).filter(Boolean))]  as number[];

  if (months.length === 0 || years.length === 0) return { found: false };

  // Find existing transactions of the same source type with overlapping months/years
  const { data: existing } = await supabase
    .from("pl_transactions")
    .select("upload_id,month,year")
    .eq("source", source)
    .in("month", months)
    .in("year", years)
    .limit(2000);

  if (!existing || existing.length === 0) return { found: false };

  // Count rows per upload_id and collect the overlap labels
  const countByUpload  = new Map<string, number>();
  const overlapByUpload = new Map<string, Set<string>>();

  for (const row of existing as { upload_id: string; month: string; year: number }[]) {
    const uid = row.upload_id;
    if (!uid) continue;
    countByUpload.set(uid, (countByUpload.get(uid) ?? 0) + 1);
    if (!overlapByUpload.has(uid)) overlapByUpload.set(uid, new Set());
    if (row.month && row.year) overlapByUpload.get(uid)!.add(`${row.month} ${row.year}`);
  }

  if (countByUpload.size === 0) return { found: false };

  const { data: uploads } = await supabase
    .from("pl_uploads")
    .select("id,file_name,uploaded_at,row_count")
    .in("id", [...countByUpload.keys()]);

  if (!uploads || uploads.length === 0) return { found: false };

  /*
   * Por cada candidato, lo que el Replace se llevaria.
   *
   * ⚠ SE CUENTA, NO SE ESTIMA. El `select` de arriba lleva `.limit(2000)`, que
   * basta para saber QUE uploads solapan pero no CUANTAS filas tienen: un
   * upload de 11.092 filas entra ahi truncado. Enseñar una cifra corta en el
   * dialogo que decide un borrado es peor que no enseñarla.
   */
  const candidates: DuplicateInfo[] = [];
  for (const u of uploads as Array<{ id: string; file_name: string; uploaded_at: string; row_count: number | null }>) {
    const { count: rows } = await supabase
      .from("pl_transactions")
      .select("*", { count: "exact", head: true })
      .eq("upload_id", u.id);

    const { count: manuales } = await supabase
      .from("pl_transactions")
      .select("*", { count: "exact", head: true })
      .eq("upload_id", u.id)
      .in("assignment_origin", ["manual", "conflict_resolved"]);

    // Los periodos que contiene. Paginado: un upload grande pasa de 1000 filas
    // y sin rango se cortaria justo donde estan los meses mas antiguos.
    const periodos = new Set<string>();
    for (let desde = 0; ; desde += 1000) {
      const { data } = await supabase
        .from("pl_transactions")
        .select("month,year")
        .eq("upload_id", u.id)
        .order("id", { ascending: true })
        .range(desde, desde + 999);
      if (!data || data.length === 0) break;
      for (const r of data as Array<{ month: string | null; year: number | null }>) {
        if (r.month && r.year) periodos.add(`${r.month} ${r.year}`);
      }
      if (data.length < 1000) break;
    }

    candidates.push({
      upload_id: u.id,
      file_name: u.file_name,
      uploaded_at: u.uploaded_at,
      row_count: u.row_count,
      overlap: [...(overlapByUpload.get(u.id) ?? [])].sort(),
      periods: [...periodos].sort(ordenarPeriodos),
      rows: rows ?? 0,
      manualAssignments: manuales ?? 0,
    });
  }

  /*
   * ⚠ LOS DE UN SOLO PERIODO PRIMERO: son los seguros de reemplazar.
   *
   * No se bloquea ninguno --puede haber una razon legitima para rehacer una
   * carga de once meses-- pero el orden pone delante lo que casi siempre se
   * busca, en vez de dejar que gane el que mas solapa.
   */
  candidates.sort(
    (a, b) =>
      a.periods.length - b.periods.length ||
      new Date(b.uploaded_at).getTime() - new Date(a.uploaded_at).getTime(),
  );

  return { found: true, candidates };
}

const MESES_ORDEN = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

/** "August 2025" antes que "June 2026": por año y luego por mes de verdad. */
function ordenarPeriodos(a: string, b: string): number {
  const [ma, ya] = a.split(" ");
  const [mb, yb] = b.split(" ");
  return Number(ya) - Number(yb) || MESES_ORDEN.indexOf(ma) - MESES_ORDEN.indexOf(mb);
}

/**
 * "July 2026" para uno, "Aug 2025 – Jun 2026 (11 months)" para varios.
 *
 * ⚠ EL RANGO SE CALCULA DE LA LISTA ORDENADA Y DICE CUANTOS SON. Un rango sin
 * el conteo --"Aug 2025 – Jun 2026"-- deja pensar que son dos meses.
 */
export function describirPeriodos(periods: string[]): string {
  if (periods.length === 0) return "no periods";
  if (periods.length === 1) return periods[0];
  const corto = (p: string) => {
    const [m, y] = p.split(" ");
    return `${m.slice(0, 3)} ${y}`;
  };
  return `${corto(periods[0])} – ${corto(periods[periods.length - 1])} (${periods.length} months)`;
}

const DELETE_CHUNK = 500;

const SELECT_PAGE = 1000;

/**
 * Deletes an upload and all associated rows.
 * Cleans up related tables first to avoid orphaned rows:
 * conflict_snapshots → cc_allocation_splits (transaction) → pl_transactions → pl_uploads
 *
 * CALLER CONTRACT: everything worth keeping from this upload must already be
 * backed up and confirmed on disk. See snapshotManualAssignments — these rows
 * are the only copy of the manual assignments and there is no rollback here.
 *
 * Every delete is chunked. authenticator runs with statement_timeout = 8s, and
 * uploads of 11,092 and 13,848 rows exist, so removing pl_transactions in one
 * statement is a real failure mode rather than a theoretical one — and a
 * timeout half-way through leaves the upload partly deleted, since none of this
 * is in a transaction.
 */
export async function deleteUpload(supabase: SupabaseClient, uploadId: string): Promise<void> {
  // Paginate the id fetch too: without a range this silently stops at the
  // PostgREST 1000-row cap, and the children of every row past that would be
  // left behind.
  const txIds: string[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("pl_transactions")
      .select("id")
      .eq("upload_id", uploadId)
      .order("id", { ascending: true })
      .range(from, from + SELECT_PAGE - 1);
    if (error) throw new Error(`deleteUpload fetch ids: ${error.message}`);
    if (!data || data.length === 0) break;
    txIds.push(...data.map((r: { id: string }) => r.id));
    if (data.length < SELECT_PAGE) break;
    from += SELECT_PAGE;
  }

  if (txIds.length > 0) {
    for (let i = 0; i < txIds.length; i += DELETE_CHUNK) {
      const chunk = txIds.slice(i, i + DELETE_CHUNK);

      // Redundant for correctness — conflict_snapshots.transaction_id is
      // ON DELETE CASCADE — but kept deliberately. It moves that cascade work
      // out of the pl_transactions delete below, which is the statement at
      // risk of the 8s timeout, and the loop has to exist anyway for
      // cc_allocation_splits, whose assign_value is plain text with no foreign
      // key and therefore no cascade of its own.
      const { error: snapErr } = await supabase
        .from("conflict_snapshots").delete().in("transaction_id", chunk);
      if (snapErr) throw new Error(`deleteUpload conflict_snapshots: ${snapErr.message}`);

      const { error: splitErr } = await supabase
        .from("cc_allocation_splits")
        .delete()
        .eq("assign_type", "transaction")
        .in("assign_value", chunk);
      if (splitErr) throw new Error(`deleteUpload cc_allocation_splits: ${splitErr.message}`);
    }

    // Chunked by explicit id list rather than one statement over upload_id.
    for (let i = 0; i < txIds.length; i += DELETE_CHUNK) {
      const chunk = txIds.slice(i, i + DELETE_CHUNK);
      const { error } = await supabase.from("pl_transactions").delete().in("id", chunk);
      if (error) throw new Error(`deleteUpload pl_transactions: ${error.message}`);
    }
  }

  // Sweeps anything inserted between the id fetch and now, so the parent row
  // never fails to delete on a leftover child.
  const { error: tailErr } = await supabase
    .from("pl_transactions").delete().eq("upload_id", uploadId);
  if (tailErr) throw new Error(`deleteUpload pl_transactions tail: ${tailErr.message}`);

  const { error: uploadErr } = await supabase.from("pl_uploads").delete().eq("id", uploadId);
  if (uploadErr) throw new Error(`deleteUpload pl_uploads: ${uploadErr.message}`);
}

// ─── El archivo entero: lo unico que se puede afirmar ────────────────────────

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ¿ESTE ARCHIVO YA SE SUBIO?
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Es una pregunta DISTINTA de `checkDuplicateUpload`, y por eso es otra
 * funcion. Aquella dice "este PERIODO ya tiene datos", que es cierto casi
 * siempre y no distingue un error de un reparto legitimo por sucursal. Esta
 * dice "este ARCHIVO ya esta", que es un hecho.
 *
 * ⚠ EL CASO, 2026-09-23. El mismo archivo subido a las 16:43 y a las 17:02.
 * El aviso de periodos salto y ofrecio "Upload anyway" a un clic; nada dijo lo
 * unico que importaba, que era el mismo archivo 19 minutos despues.
 *
 * ⚠ DOS SEÑALES, Y NO SON LA MISMA:
 *
 *   hash    el contenido. Caza el archivo renombrado, que es el que nadie ve.
 *           Solo existe desde el 2026-09-23: los uploads anteriores lo tienen
 *           NULL porque los archivos no se guardan y no hay de donde sacarlo.
 *   nombre  alcanza tambien a los viejos, y es la señal que el usuario
 *           reconoce -- "pero si es el mismo archivo".
 *
 * Se devuelven las dos por separado para que el aviso pueda decir CUAL casa.
 * "Mismo contenido, otro nombre" y "mismo nombre" son dos situaciones
 * distintas y la segunda puede ser deliberada -- un archivo corregido que
 * conserva el nombre.
 */
export type SameFileMatch = {
  upload_id: string;
  file_name: string;
  uploaded_at: string;
  row_count: number | null;
  /** Por que casa: el contenido, el nombre, o los dos. */
  by: ("hash" | "name")[];
};

export async function findSameFile(
  supabase: SupabaseClient,
  fileName: string,
  fileHash: string,
): Promise<SameFileMatch[]> {
  const { data } = await supabase
    .from("pl_uploads")
    .select("id,file_name,uploaded_at,row_count,file_hash")
    .or(`file_hash.eq.${fileHash},file_name.eq.${fileName}`)
    .order("uploaded_at", { ascending: false })
    .limit(20);

  type Fila = {
    id: string; file_name: string; uploaded_at: string;
    row_count: number | null; file_hash: string | null;
  };

  return ((data ?? []) as Fila[]).map((u) => {
    const by: ("hash" | "name")[] = [];
    if (u.file_hash === fileHash) by.push("hash");
    if (u.file_name === fileName) by.push("name");
    return {
      upload_id: u.id,
      file_name: u.file_name,
      uploaded_at: u.uploaded_at,
      row_count: u.row_count,
      by,
    };
  /* El `.or` casa por nombre O por hash; un hash nulo no casa con nada, asi
     que `by` nunca sale vacio. El filtro esta por si acaso: una fila sin
     ninguna de las dos señales no tendria nada que decirle al usuario. */
  }).filter((m) => m.by.length > 0);
}
