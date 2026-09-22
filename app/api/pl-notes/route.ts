import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { canonicalScopeKey, type NoteScope } from "@/lib/note-scope";
import { txFingerprint, FINGERPRINT_SELECT, type FingerprintableTx } from "@/lib/tx-fingerprint";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * REQUIRES supabase/migrations/20260816_pl_notes_amount_at_creation.sql.
 *
 * Verified by running it: with the column absent PostgREST answers "column
 * pl_notes.amount_at_creation does not exist" and this endpoint returns
 * nothing, so the migration has to be applied before this branch is deployed.
 * Stated here rather than guarded around, because a fallback that quietly
 * dropped the column would leave every note reading "current amount" for
 * reasons nobody could see.
 */
const SELECT =
  "id,level,scope,scope_key,transaction_id,tx_fingerprint,orphaned_at,amount_at_creation,note_text,author,created_at,updated_at";

/**
 * All notes for a report. Deliberately a separate endpoint from /api/pl-all:
 * the pivot is built client-side from raw transactions, so there are no cells
 * server-side to join notes onto; and posting a note must refresh only the
 * notes, not re-download 12k+ transactions.
 *
 * Optional ?year= narrows the result. Notes with no year in scope always come
 * back — they are anchored across periods and can roll up into any of them.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const years = searchParams.getAll("year");
  // Exact-anchor lookup, used by the per-entity logs (a cost center's history,
  // an employee's, a vendor's). Those need one precise anchor, not the roll-up
  // the pivot performs, so they hit the scope_key index directly.
  const level    = searchParams.get("level");
  const scopeKey = searchParams.get("scope_key");

  const supabase = createServerClient();
  const all: unknown[] = [];
  let offset = 0;

  while (true) {
    let q = supabase
      .from("pl_notes")
      .select(SELECT)
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(offset, offset + 999);

    if (level)    q = q.eq("level", level);
    if (scopeKey) q = q.eq("scope_key", scopeKey);

    const { data, error } = await q;

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < 1000) break;
    offset += 1000;
  }

  if (years.length === 0) return NextResponse.json(all);

  const wanted = new Set(years.map(String));
  const filtered = (all as { scope: NoteScope }[]).filter((n) => {
    const y = n.scope?.year;
    return y === undefined || y === null || wanted.has(String(y));
  });
  return NextResponse.json(filtered);
}

export async function POST(req: NextRequest) {
  /**
   * Who wrote it comes from the session, never from the caller.
   *
   * `author` used to be read from the request body — a field the client never
   * sent, which is why all 21 existing notes are anonymous. Taking it from the
   * session fixes that and closes the other half at the same time: a body field
   * meant anyone could sign a note with anyone's name. That was harmless while
   * nothing wrote it and stops being harmless the moment the field is used to
   * ask somebody about their note.
   */
  const guard = await requireSession();
  if (guard.response) return guard.response;

  let body: {
    level?: string;
    scope?: NoteScope;
    transaction_id?: string | null;
    note_text?: string;
    /** The cell’s figure as the writer saw it. Absent means unknown, which
     *  is different from zero and is rendered as such. */
    amount_at_creation?: number | null;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const noteText = body.note_text?.trim();
  if (!noteText) return NextResponse.json({ error: "note_text is required" }, { status: 400 });
  if (!body.level)  return NextResponse.json({ error: "level is required" }, { status: 400 });
  if (!body.scope || typeof body.scope !== "object") {
    return NextResponse.json({ error: "scope is required" }, { status: 400 });
  }

  /*
   * ─────────────────────────────────────────────────────────────────────────
   * UN MES SIN AÑO NO ANCLA A NINGUNA CELDA: ANCLA A TODAS LAS DE ESE MES
   * ─────────────────────────────────────────────────────────────────────────
   *
   * El eje de la rejilla son NOMBRES de mes --"August"-- asi que una nota con
   * `month` y sin `year` sale en agosto de 2025 Y en agosto de 2026.
   *
   * ⚠ NO ES UN FALLO DEL NIVEL `description`, Y ASI PARECIA. De las 39 notas,
   * las 2 sin año son de ese nivel, pero el año NO lo pone cada nivel: lo pone
   * `reportBaseScope` para todos. Lo que decide es OTRA cosa:
   *
   *     const scopeYear = ys.size === 1 ? [...ys][0] : undefined;   // app/pl/page.tsx
   *
   * Con DOS años cargados a la vez, `scopeYear` es `undefined` y la nota se
   * guarda sin año -- en cualquier nivel. Las 2 que existen se escribieron asi,
   * una de ellas el 2026-09-22.
   *
   * ⚠ Y CON DOS AÑOS CARGADOS LA CELDA YA ERA AMBIGUA ANTES DE LA NOTA: la
   * columna "August" suma los dos agostos. Asi que no se puede "adivinar" el
   * año de la nota -- no hay uno. Se rechaza y se dice por que, que es lo unico
   * honesto: la alternativa seria elegir un año a suertes y dejarlo escrito
   * como si alguien lo hubiera decidido.
   *
   * Se comprueba AQUI y no en la pantalla porque este es el unico sitio por el
   * que pasan todas: una sola ruta crea notas.
   */
  const scope = body.scope as Record<string, unknown>;
  if (scope.month != null && scope.year == null) {
    return NextResponse.json({
      error:
        "This note would attach to that month in every loaded year. The report has " +
        "more than one year loaded, so the cell has no single year — narrow the " +
        "Year filter to one and write it again.",
    }, { status: 400 });
  }

  const supabase = createServerClient();

  // Derive the fingerprint server-side from the live row, so the client cannot
  // supply one that does not match the transaction it claims to annotate.
  let fingerprintValue: string | null = null;
  if (body.transaction_id) {
    const { data: tx } = await supabase
      .from("pl_transactions")
      .select(FINGERPRINT_SELECT)
      .eq("id", body.transaction_id)
      .single();
    if (!tx) return NextResponse.json({ error: "Transaction not found" }, { status: 404 });
    fingerprintValue = txFingerprint(tx as unknown as FingerprintableTx);
  }

  const { data, error } = await supabase
    .from("pl_notes")
    .insert({
      level:          body.level,
      scope:          body.scope,
      scope_key:      canonicalScopeKey(body.scope),
      transaction_id: body.transaction_id ?? null,
      tx_fingerprint: fingerprintValue,
      note_text:      noteText,
      author:         guard.user.email ?? null,
      // Stored, never derived. A figure recomputed later is a different
      // number, and the point of keeping this one is to be able to say so.
      amount_at_creation:
        typeof body.amount_at_creation === "number" && Number.isFinite(body.amount_at_creation)
          ? body.amount_at_creation
          : null,
    })
    .select(SELECT)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
