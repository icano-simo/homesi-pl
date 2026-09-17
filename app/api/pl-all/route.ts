import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import type { PLReportTx } from "@/types";
import { filaEntraEnLente, type AffinityLens } from "@/lib/loan-branch";
import { getAffinityLoanNumbers } from "@/lib/loan-source";

export const dynamic = "force-dynamic";

const SELECT =
  "id,month,year,branch,journal_post_date,check_description,check_description_2,check_description_3," +
  "vendor,ref_numb,debit,credit,movement,operational_pct,loan_number," +
  "gl_code,gl_name,category_2,category_6,category_7,order_1,order_2,order_3," +
  "cost_center_id,cost_center_status,cost_centers(name)";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const years    = searchParams.getAll("year");
  const branches = searchParams.getAll("branch");
  const sources  = searchParams.getAll("source");

  /*
   * La lente de Affinity. Sin el parametro, "ambas": una peticion que no la
   * menciona se comporta como siempre, asi que ninguna otra pantalla cambia.
   *
   * ⚠ LA PARTICION SE HACE AQUI Y NO EN EL CLIENTE. La rejilla se arma en la
   * pagina a partir de estas filas, y clasificarlas alli obligaria a llevar al
   * navegador el conjunto de prestamos de Affinity y a repetir la regla -- una
   * segunda definicion de "que es de Affinity" separandose de esta sin que nada
   * falle. La regla vive en lib/loan-branch.ts y solo se aplica aqui.
   */
  const lenteParam = searchParams.get("lens");
  const lente: AffinityLens =
    lenteParam === "affinity" || lenteParam === "716" ? lenteParam : "ambas";

  /*
   * Solo se paga la lectura cuando hace falta. Con la lente en "ambas" --el
   * caso de siempre y el de todas las demas pantallas-- no se consulta nada.
   */
  const prestamosAffinity =
    lente === "ambas" ? new Set<string>() : await getAffinityLoanNumbers();

  const supabase = createServerClient();
  const all: PLReportTx[] = [];
  let offset = 0;

  while (true) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = supabase.from("pl_transactions").select(SELECT)
      .order("journal_post_date", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + 999);
    if (years.length > 0)    q = q.in("year", years.map((y) => parseInt(y, 10)));
    if (branches.length > 0) q = q.in("branch", branches);
    if (sources.length > 0)  q = q.in("source", sources);

    const { data, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;
    /*
     * Se filtra por pagina y no al final: con un año entero de la division son
     * decenas de miles de filas, y quedarse con las que no se van a enseñar
     * solo para descartarlas despues es memoria que no hace falta.
     */
    const pagina = data as PLReportTx[];
    all.push(
      ...(lente === "ambas"
        ? pagina
        : pagina.filter((t) =>
            filaEntraEnLente(
              {
                branch: t.branch ?? null,
                loan_number: t.loan_number ?? null,
                gl_code: t.gl_code ?? null,
                check_description: t.check_description ?? null,
              },
              lente,
              (ln) => prestamosAffinity.has(ln),
            ),
          )),
    );
    if (data.length < 1000) break;
    offset += 1000;
  }

  return NextResponse.json(all);
}
