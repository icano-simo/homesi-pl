import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { requireSession } from "@/lib/auth";
import { getClosedLoans } from "@/lib/loan-source";

const MONTH_ORDER = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * ESTA PANTALLA CAMBIA DE PREGUNTA
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Antes contestaba "que hay cargado", leyendo el archivo. Ahora el archivo ya no
 * es la fuente -- lo es `activity_report.loan_records_v2`, ver lib/loan-source --
 * asi que contestar lo mismo dejaria una pantalla que describe algo que ya no
 * alimenta nada.
 *
 * Contesta "QUE HAY, Y QUE TRAIA TU ARCHIVO", los dos a la vez. Medido el
 * 2026-09-15: el archivo tenia 436 prestamos de una carga del 20 de agosto y el
 * espejo 494. Agosto de 2026 es el caso que lo enseña solo: 47 cierres en el
 * espejo y CERO en el archivo.
 *
 * ⚠ ESA DIFERENCIA ES EL PUNTO, no un efecto secundario. Quien sube un archivo
 * hoy no tiene forma de saber cuanto se esta perdiendo; con las dos columnas al
 * lado, la subida pasa de ser una accion sin efecto a un diagnostico. Y el dia
 * que Salesforce se pare --paso tres dias este mes-- es justo la cifra que dice
 * cuanto hace que no llega nada.
 *
 * El DELETE de abajo NO migra, y es deliberado: borra lo que alguien subio, que
 * sigue viviendo en el archivo. Borrar del espejo no es cosa de esta app.
 */
export async function GET() {
  const supabase = createServerClient();

  const [espejo, archivo] = await Promise.all([
    getClosedLoans(),
    supabase
      .from("loan_officials")
      .select("month, year, created_at, updated_at")
      .order("year", { ascending: false }),
  ]);

  if (archivo.error) {
    return NextResponse.json({ error: archivo.error.message }, { status: 500 });
  }

  type Periodo = {
    month: string;
    year: number;
    /** Cierres en el espejo. Es la cifra viva. */
    count: number;
    /** Prestamos que traia el archivo subido, si hubo subida. */
    file_count: number;
    /** Cuantos ve el espejo que el archivo no tiene. Nunca negativo. */
    missing_from_file: number;
    last_updated: string;
  };
  const map = new Map<string, Periodo>();
  const clave = (m: string, y: number) => `${m}|${y}`;
  const vacio = (m: string, y: number): Periodo => ({
    month: m, year: y, count: 0, file_count: 0, missing_from_file: 0, last_updated: "",
  });

  // El espejo manda, asi que va primero y define que periodos existen.
  for (const l of espejo) {
    // `closing_month` es un date ("2026-07-01"); la pantalla habla de meses.
    if (!l.closingMonth) continue;
    const [y, m] = l.closingMonth.split("-");
    const mes = MONTH_ORDER[Number(m) - 1];
    const anio = Number(y);
    if (!mes || !anio) continue;
    const k = clave(mes, anio);
    const p = map.get(k) ?? vacio(mes, anio);
    p.count++;
    map.set(k, p);
  }

  // El archivo se suma encima, y puede traer periodos que el espejo no tiene:
  // tambien esos hay que enseñarlos, o una carga vieja desaparece sin rastro.
  for (const row of archivo.data ?? []) {
    const k = clave(row.month, row.year);
    const p = map.get(k) ?? vacio(row.month, row.year);
    p.file_count++;
    const ts = row.updated_at ?? row.created_at ?? "";
    if (ts > p.last_updated) p.last_updated = ts;
    map.set(k, p);
  }

  for (const p of map.values()) {
    p.missing_from_file = Math.max(0, p.count - p.file_count);
  }

  const periods = Array.from(map.values()).sort((a, b) => {
    if (b.year !== a.year) return b.year - a.year;
    return MONTH_ORDER.indexOf(b.month) - MONTH_ORDER.indexOf(a.month);
  });

  return NextResponse.json(periods);
}

export async function DELETE(req: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { searchParams } = new URL(req.url);
  const month = searchParams.get("month");
  const year = searchParams.get("year");

  if (!month || !year) {
    return NextResponse.json({ error: "month and year are required" }, { status: 400 });
  }

  const supabase = createServerClient();
  const { error, count } = await supabase
    .from("loan_officials")
    .delete({ count: "exact" })
    .eq("month", month)
    .eq("year", Number(year));

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ deleted: count ?? 0 });
}
