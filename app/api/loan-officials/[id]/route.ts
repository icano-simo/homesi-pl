import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { requireSession } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Las tres que son una opinion, y solo esas.
 *
 * Eran cinco booleanos y dos textos. `affinity`, `recruitment`, `lead_source_lo`
 * y `bd_owner` salen ahora del origen --strategy y Encompass-- y por eso no
 * estan aqui: darles una casilla editable seria crear una segunda opinion sobre
 * algo que Salesforce ya afirma. El detalle esta en la ruta de la lista.
 */
const CAMPOS = new Set(["b2b", "processing", "support_on_demand"]);

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * CLASIFICAR UN PRESTAMO
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ ESTO ESCRIBIA EN UN SITIO QUE YA NADIE LEIA. Hasta este commit el PATCH
 * actualizaba `finance_division.loan_officials` --el archivo-- mientras el resto
 * de la app leia las clasificaciones de `finance_division.loan_manual_flags`.
 * O sea: se clasificaba, la pantalla decia que se habia guardado, y ninguna
 * cifra se movia. No fallaba nada, que es lo que lo hacia peor.
 *
 * ⚠ Y NO BASTABA CON CAMBIAR LA TABLA: SON DOS CLAVES DISTINTAS. El PATCH se
 * dirigia por `id`, un uuid de fila del archivo, y las clasificaciones se
 * llavean por `loan_number`. Los 61 cierres de agosto y septiembre no existen
 * en el archivo, asi que no tenian id -- no se podian nombrar, y por tanto no se
 * podian clasificar ni aunque el destino hubiera sido el correcto.
 *
 * El parametro de ruta se llama `id` por compatibilidad de URL, pero lo que
 * lleva es un `loan_number`.
 *
 * ⚠ `set_by` SALE DE LA SESION, NUNCA DEL CUERPO. Mismo criterio que el autor de
 * las notas del P&L: un campo de autoria que el cliente puede rellenar no dice
 * quien hizo algo, dice quien dijo que lo hizo.
 *
 * ⚠ UPSERT QUE CREA LA FILA. Un prestamo sin clasificar no tiene fila en
 * loan_manual_flags -- son 247 de 494 --, asi que un update a secas no escribiria
 * nada y devolveria "ok". Los 16 que Salesforce marca B2B y nadie ha revisado
 * son justo ese caso: sin crear fila, seguirian siendo una cola inaccionable.
 *
 * Las 247 filas existentes las escribio la migracion del 2026-09-13 desde
 * loan_officials_class_backup_20260913. No hay ningun proceso externo que
 * mantenga esta tabla: esta escritura es la primera, no una segunda fuente.
 */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { id: loanNumber } = await params;
  const body = await req.json().catch(() => ({}));

  const cambios: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(body)) {
    if (CAMPOS.has(k) && typeof v === "boolean") cambios[k] = v;
  }

  if (Object.keys(cambios).length === 0) {
    return NextResponse.json(
      {
        error:
          "No valid fields provided. Only b2b, processing and support_on_demand " +
          "are set by hand; affinity, recruitment and lead source come from the source.",
      },
      { status: 400 },
    );
  }

  const supabase = createServerClient();

  /*
   * Se lee la fila antes de escribirla para no borrar las otras dos casillas.
   * `upsert` reemplaza la fila entera, asi que enviar solo el campo que cambio
   * pondria los otros dos a null -- y null aqui significa "nadie lo ha mirado",
   * o sea que una clasificacion existente se leeria como nunca hecha.
   */
  const { data: actual } = await supabase
    .from("loan_manual_flags")
    .select("b2b,processing,support_on_demand,note")
    .eq("loan_number", loanNumber)
    .maybeSingle();

  const fila = {
    loan_number: loanNumber,
    b2b: actual?.b2b ?? null,
    processing: actual?.processing ?? null,
    support_on_demand: actual?.support_on_demand ?? null,
    note: actual?.note ?? null,
    ...cambios,
    source: "ui",
    set_by: guard.user.email ?? null,
    set_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("loan_manual_flags")
    .upsert(fila, { onConflict: "loan_number" })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(data);
}
