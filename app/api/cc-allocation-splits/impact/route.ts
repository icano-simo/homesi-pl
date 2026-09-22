import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * A CUANTO ALCANZA ESTA REGLA DE REPARTO, ANTES DE GUARDARLA
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Un split se llavea por un TEXTO --el nombre del proveedor, o
 * `check_description_3`-- y ese texto casa contra texto libre del archivo. Si
 * el valor es comun, la regla se convierte en un comodin.
 *
 * ⚠ EL CASO QUE LO OBLIGA, el 2026-09-21. Alguien creo un split sobre el
 * proveedor `Default` al 100% hacia CC03-B2B. "Default" no es un proveedor: es
 * el relleno mas comun del archivo, **740 filas, 14 cuentas, 1.212.355,83**.
 * La regla se llevo 198.923,84 de CC01, CC04 y Direct cost normalization a
 * CC03. No fallo nada: el total seguia cuadrando, porque el dinero no se
 * duplicaba, se mudaba. Se vio tres dias despues y porque alguien noto que un
 * ceco tenia mas margen del que le tocaba.
 *
 * ⚠ Y AL MIRAR LOS VALORES GRANDES, CASI NINGUNO ES UN PROVEEDOR.
 * `Telephone & VOIP`, `Payroll Tax Expense`, `Marketing Expense`,
 * `Operations Payroll`, `Processing Fees`, `Loan Setup`... son nombres de
 * cuenta usados como relleno. Esos son los que hay que mirar dos veces, y el
 * umbral de abajo esta elegido para distinguirlos de un proveedor de verdad.
 *
 * ⚠ AVISA, NO BLOQUEA. Una regla amplia puede ser exactamente lo que se
 * quiere, y quien la crea sabe mas que esta funcion. Lo que no puede pasar es
 * que se cree a ciegas.
 */

/**
 * ⚠ EL AVISO NO MIRA EL TAMAÑO, Y ESTA MEDIDO. Sobre los 182 valores de
 * `vendor`:
 *
 *     avisar por "mas de 100 filas"        12 valores  <- incluye CIC INC
 *     avisar por dispersion (lo de abajo)  10          <- incluye Default
 *
 * `CIC INC` tiene 1.982 filas, UN solo centro de coste y dos cuentas: es el
 * proveedor mas grande que hay y una regla sobre el no remueve nada. Avisar
 * por tamaño gritaria justo ahi. `Default` tiene 740 filas repartidas en
 * CUATRO centros ya asignados y CATORCE cuentas -- eso es lo que lo hace un
 * comodin.
 *
 * Las filas se siguen enseñando siempre, como contexto. Lo que no hacen es
 * disparar el aviso por si solas.
 */
/** Centros de coste YA ASIGNADOS de los que la regla sacaria filas. Dos es
 *  normal --un proveedor repartido--; tres ya es remover decisiones ajenas. */
const VARIOS_CECOS = 3;
/** Cuentas distintas. Un proveedor de verdad toca una o dos; catorce es el
 *  perfil de un relleno del archivo, no el de un servicio. */
const MUCHAS_CUENTAS = 5;

export interface SplitImpact {
  rows: number;
  amount: number;
  /** De donde saldrian esas filas hoy, ordenado por importe. */
  costCenters: { name: string; rows: number; amount: number }[];
  /** Cuantas cuentas distintas toca. "Default" tocaba catorce. */
  accounts: number;
  /** true cuando conviene mirarlo dos veces. Nunca impide guardar. */
  broad: boolean;
  reasons: string[];
}

export async function GET(req: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const sp = new URL(req.url).searchParams;
  const tipo = sp.get("assign_type");
  const valor = (sp.get("assign_value") ?? "").trim();
  if ((tipo !== "vendor" && tipo !== "description3") || !valor) {
    return NextResponse.json({ error: "assign_type y assign_value son obligatorios" }, { status: 400 });
  }

  const sb = createServerClient();
  const columna = tipo === "vendor" ? "vendor" : "check_description_3";

  /*
   * Se pagina por la misma razon que en todas partes de este proyecto: un
   * select sin rango se corta en 1000 filas, y "Default" tiene 740 -- el
   * siguiente comodin puede tener mas y el aviso saldria mas pequeño que la
   * realidad, que es la peor manera de fallar para un aviso.
   */
  type Fila = { movement: number | null; gl_code: string | null; cost_center_id: string | null; cost_centers: { name: string } | null };
  const filas: Fila[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await sb
      .from("pl_transactions")
      .select("movement,gl_code,cost_center_id,cost_centers(name)")
      .eq(columna, valor)
      .order("id", { ascending: true })
      .range(off, off + 999);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data?.length) break;
    filas.push(...(data as unknown as Fila[]));
    if (data.length < 1000) break;
  }

  const porCeco = new Map<string, { rows: number; amount: number }>();
  const cuentas = new Set<string>();
  let amount = 0;
  for (const f of filas) {
    const n = f.cost_centers?.name ?? "(sin centro de coste)";
    const e = porCeco.get(n) ?? { rows: 0, amount: 0 };
    e.rows++; e.amount += Number(f.movement ?? 0);
    porCeco.set(n, e);
    if (f.gl_code) cuentas.add(f.gl_code);
    amount += Number(f.movement ?? 0);
  }

  /*
   * ⚠ "(sin centro de coste)" NO CUENTA como sitio del que se saca dinero: esas
   * filas no las habia puesto nadie. Sin esta resta, casi cualquier regla
   * parece que remueve varios cecos y el aviso se vuelve ruido.
   */
  const conDueño = [...porCeco.keys()].filter((n) => n !== "(sin centro de coste)").length;

  const reasons: string[] = [];
  if (conDueño >= VARIOS_CECOS) reasons.push(`it pulls rows out of ${conDueño} cost centres that are already assigned`);
  if (cuentas.size > MUCHAS_CUENTAS) reasons.push(`it spans ${cuentas.size} different accounts`);

  const res: SplitImpact = {
    rows: filas.length,
    amount,
    accounts: cuentas.size,
    costCenters: [...porCeco.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)),
    broad: reasons.length > 0,
    reasons,
  };
  return NextResponse.json(res);
}
