import { NextResponse } from "next/server";
import { getClosedLoans } from "@/lib/loan-source";

export const dynamic = "force-dynamic";

const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

/*
 * Los periodos que la pantalla puede ofrecer.
 *
 * Del espejo, y eso tiene una consecuencia visible: aparecen August y September
 * 2026, que el archivo no tenia. Sin esto, la pantalla habria seguido sin
 * ofrecer los dos meses mas recientes -- y un mes que falta en un desplegable no
 * se lee como "no esta cargado", se lee como "no hubo cierres".
 *
 * Ya no hace falta paginar a mano: getClosedLoans lo hace, por la misma razon
 * que lo hacia esta ruta -- una opcion que falta porque el fetch se corto a las
 * 1000 filas es indistinguible de un filtro que no funciona.
 */
export async function GET() {
  const cerrados = await getClosedLoans();

  const meses = new Set<string>();
  const anios = new Set<number>();
  for (const l of cerrados) {
    const [y, m] = (l.closingMonth ?? "").split("-");
    const mes = m ? MONTH_NAMES[Number(m) - 1] : null;
    if (mes) meses.add(mes);
    if (Number(y)) anios.add(Number(y));
  }

  // En orden de calendario, no de aparicion: el desplegable los enseña asi.
  const months = MONTH_NAMES.filter((m) => meses.has(m));
  const years = [...anios].sort((a, b) => a - b);

  // No devuelve branches: su unico consumidor era el desplegable Branch de la
  // barra de Loan Validation, que se fue con la pestaña B2B.
  return NextResponse.json({ months, years });
}
