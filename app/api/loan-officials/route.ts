import { NextRequest, NextResponse } from "next/server";
import { getClosedLoans } from "@/lib/loan-source";

export const dynamic = "force-dynamic";

const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * LA LISTA DE LA PANTALLA DE CLASIFICACION
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Sale del espejo, no del archivo. Y va en el MISMO commit que el PATCH que la
 * acompaña, a proposito: migrar solo la lista dejaria la pantalla enseñando 61
 * prestamos de agosto y septiembre que NO SE PUEDEN CLASIFICAR, porque no
 * existen en el archivo y por tanto no tienen `id` al que dirigir la escritura.
 *
 *
 * ── ⚠ LA IDENTIDAD DE UNA FILA ES `loan_number`, NO `id` ────────────────────
 *
 * Y ese cambio es el que hacia falta, no el de la tabla. El PATCH se dirigia
 * por `id` de fila de `loan_officials` --un uuid del archivo-- y las
 * clasificaciones viven en `loan_manual_flags`, que se llavea por
 * `loan_number`. Con dos claves distintas no bastaba con cambiar el destino de
 * la escritura: un prestamo que el archivo no tiene no tiene id, y por tanto no
 * habia forma de nombrarlo.
 *
 * `id` desaparece de estas filas. Quien lo use para algo mas que una key de
 * React tiene que mirarlo.
 *
 *
 * ── ⚠ CINCO CASILLAS PASAN A SER TRES, Y NO ES UNA PERDIDA ──────────────────
 *
 * `loan_manual_flags` tiene sitio para b2b, support_on_demand y processing, y
 * no para affinity ni recruitment. No es un olvido del esquema: esas dos ya no
 * son una opinion manual.
 *
 *   affinity     sale de `strategy` = 'Affinity'. Medido sobre los 433
 *                prestamos presentes en las dos fuentes: CERO diferencias con
 *                la columna del archivo. Nadie las estaba clasificando
 *                distinto.
 *   recruitment  sale de `strategy` = 'Recruitment'. Dos diferencias, y las dos
 *                son disputas de verdad: 710001998384 de Sergio Vermejo, que
 *                Salesforce clasifica Recruitment y el archivo no; y
 *                747002052489 de Gian Laino, que el archivo marca recruitment y
 *                Salesforce clasifica B2B -- el mismo prestamo del unico
 *                b2bDiscrepa, o sea alguien que miro y dijo otra cosa.
 *   lead_source  sale de Encompass. El archivo traia 103 residuos de captura.
 *   bd_owner     sale de `bd` en el espejo.
 *
 * Dejarlas editables contra una tabla que no las guarda seria escribir en el
 * vacio; darles una columna nueva seria crear una segunda opinion sobre algo
 * que Salesforce ya afirma, que es justo el patron de "dos mecanismos para la
 * misma pregunta" que este modulo lleva tiempo desmontando.
 *
 * La disputa de Gian Laino no se pierde por esto: sale marcada como
 * discrepancia, que es mas visible que una casilla que alguien cambio una vez.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const months = searchParams.getAll("month");
  const years = searchParams.getAll("year").map(Number).filter((n) => !isNaN(n));

  const cerrados = await getClosedLoans();

  const filas = cerrados
    .map((l) => {
      const [y, m] = (l.closingMonth ?? "").split("-");
      return {
        // La clave. No hay `id`: ver la nota de arriba.
        loan_number: l.loanNumber,
        borrower_name: l.borrowerName,
        loan_officer: l.loanOfficer,
        loan_info_channel: l.loanChannel,
        branch: l.branch,
        loan_amount: l.loanAmount,
        loan_program: l.loanProgram,
        month: m ? MONTH_NAMES[Number(m) - 1] ?? null : null,
        year: Number(y) || null,

        // ── Editables: viven en loan_manual_flags ──────────────────────────
        // Null es "nadie lo ha mirado", que no es lo mismo que false. La
        // pantalla los distingue.
        b2b: l.b2bManual,
        processing: l.processing,
        support_on_demand: l.supportOnDemand,

        // ── Derivados: los afirma el origen, no se editan ──────────────────
        strategy: l.strategy,
        affinity: l.strategy === "Affinity",
        recruitment: l.strategy === "Recruitment",
        lead_source_lo: l.leadSource,

        /** Salesforce dice B2B y nadie lo ha clasificado. Cola de trabajo. */
        b2b_unclassified: l.b2bSinClasificar,
        /** Hay clasificacion manual y dice lo contrario que Salesforce. */
        b2b_disputed: l.b2bDiscrepa,
        b2b_salesforce: l.b2bSalesforce,
      };
    })
    .filter((r) => (months.length > 0 ? r.month !== null && months.includes(r.month) : true))
    .filter((r) => (years.length > 0 ? r.year !== null && years.includes(r.year) : true))
    .sort((a, b) =>
      (b.year ?? 0) - (a.year ?? 0) ||
      MONTH_NAMES.indexOf(b.month ?? "") - MONTH_NAMES.indexOf(a.month ?? "") ||
      a.loan_number.localeCompare(b.loan_number),
    );

  return NextResponse.json(filas);
}
