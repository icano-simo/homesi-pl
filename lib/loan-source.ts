import { createServerClient } from "@/lib/supabase-server";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * DE DONDE SALEN LOS PRESTAMOS CERRADOS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * El unico sitio donde vive la definicion de "que cuenta". Nueve rutas hacian
 * esa pregunta por su cuenta contra `finance_division.loan_officials`, y nueve
 * sitios donde se puede escribir el filtro distinto son nueve definiciones que
 * se van separando sin que nada falle.
 *
 *
 * ── POR QUE SE DEJA DE LEER EL ARCHIVO ──────────────────────────────────────
 *
 * `loan_officials` es el archivo que alguien sube a mano. Medido el 2026-09-15:
 *
 *     finance_division.loan_officials    436 prestamos · ultima carga 20 agosto
 *     activity_report.loan_records_v2    494 cierres    · sincronizado a diario
 *
 * El archivo tiene tres semanas. Y no es solo que falten filas: Compensafe pago
 * comision por 54 prestamos que el archivo no tiene, 125.521,22 en total, y 44
 * de esos 54 ya estaban en el espejo. El bloque 1 del modulo de P&L por Loan
 * Officer estaba corto en volumen, margen y comision a la vez, sin sintoma.
 *
 * ⚠ EL ARCHIVO NO DESAPARECE, y esto no es una migracion a medias. La subida se
 * queda como respaldo: el espejo depende de que Salesforce sincronice, y eso
 * estuvo parado tres dias este mes. Lo que cambia es cual manda -- ver
 * `FUENTE_VIVA` abajo.
 *
 *
 * ── EL FILTRO, Y POR QUE ES `counts_for_division` Y NO `is_closed` ──────────
 *
 * Medido sobre el espejo el 2026-09-15: 499 cierres, de los que 494 cuentan
 * para la division. Los 5 de diferencia son HELOC de segundo gravamen, y son la
 * UNICA exclusion -- no hay ningun otro motivo por el que un cierre no cuente.
 *
 * Un HELOC de segundo gravamen le suma al loan officer y no a la division, asi
 * que usar `is_closed` a secas en un agregado infla los cierres sin que nada
 * falle. Por eso el filtro son las dos condiciones y vive aqui.
 *
 *
 * ── LAS CLASIFICACIONES MANUALES NO SE TOCAN ────────────────────────────────
 *
 * `finance_division.loan_manual_flags` tiene 247 filas -- b2b 106,
 * support_on_demand 103, processing 150 -- y se cruzan por `loan_number`. Se
 * leen, nunca se escriben desde aqui.
 *
 * Comprobado antes de construir el join: las 247 tienen su `loan_number` en el
 * espejo cerrado, cero huerfanas. Pero solo 244 sobreviven a
 * `counts_for_division`: las TRES que faltan son HELOC de segundo gravamen
 * --Luis Silva una, Haydee Tito-Pace dos, las tres con b2b=false--. No es un
 * fallo del cruce: su clasificacion manual existe y no aplica al conteo de la
 * division, igual que el prestamo.
 *
 * ⚠ LOS DOS b2b SE ENSEÑAN ETIQUETADOS, SIN UNIFICAR. El manual y el de
 * Salesforce discrepan, y la discrepancia es informacion, no ruido. Medido
 * sobre los 494:
 *
 *     los dos              84
 *     solo manual          22   -- 13 con strategy=NPPM, 9 con Own Production
 *     solo Salesforce      17   -- Buendia 5, Zegarra 5, Laino 5, Castro,
 *                                 Garcia
 *     ninguno             371
 *
 * Los 13 de NPPM son precedencia de estrategia: Salesforce ya los clasifico
 * como NPPM y no puede marcarlos B2B a la vez. Los 9 de Own Production son
 * discutibles de verdad. Unificarlos a uno de los dos lados perderia esas dos
 * lecturas y nadie sabria que existieron.
 */

/** El espejo manda; el archivo es respaldo. */
export const FUENTE_VIVA = "activity_report.loan_records_v2" as const;

/**
 * Un prestamo cerrado tal como lo cuenta la division, con sus clasificaciones.
 *
 * Los nombres de campo salen del espejo, no del archivo: quien venia de
 * `loan_officials` tiene que mirar el mapeo y no asumir que se llaman igual.
 */
export interface ClosedLoan {
  loanNumber: string;
  borrowerName: string | null;
  /** `loan_officer_name` en la vista de origen. */
  loanOfficer: string | null;
  /**
   * El codigo canonico, cuando el origen lo trae.
   *
   * ⚠ VIENE NULO A MENUDO, y se midio antes de apoyarse en el: 416 de los 494
   * cierres lo traen -- el 84% --, pero por PERSONAS son 28 de 45. Los 17 sin
   * codigo tienen pocos cierres cada uno, y son justo la poblacion que el
   * emparejador ya no resolvia: Heibel, Fowler, Tirio, DiToma, Ballon, Winter,
   * Edwards, Holmes, Kontny, Quansah, De Anda, Gonzalez, Vermejo, Anderson,
   * Aguillon y los dos Frank.
   *
   * O sea que ESTO NO SUSTITUYE AL EMPAREJADOR. Se midio: resolver por
   * person_code mas emparejador da 29 de 45, contra 30 de 46 leyendo el
   * archivo. No es una mejora, es lo mismo. Quien lo lea esperando que el
   * problema de nombres se haya arreglado solo, se va a equivocar.
   */
  personCode: string | null;
  branch: string | null;
  loanAmount: number | null;
  closingMonth: string | null;
  /** `Own Production` | `B2B` | `Affinity` | `Recruitment` | `NPPM`. */
  strategy: string | null;
  /** El b2b de Salesforce, derivado de `strategy`. */
  b2bSalesforce: boolean;
  /** El b2b clasificado a mano. Null cuando el prestamo no tiene fila de flags. */
  b2bManual: boolean | null;
  supportOnDemand: boolean | null;
  processing: boolean | null;
  /**
   * DOS OPINIONES OPUESTAS sobre el mismo prestamo.
   *
   * ⚠ EXIGE QUE HAYA CLASIFICACION MANUAL. Sin fila de flags no hay con que
   * discrepar: que nadie lo haya clasificado no es lo mismo que haberlo
   * clasificado como "no". Por eso son 23 y no 39 sobre los 494.
   *
   * ⚠ Y EL CASO QUE MAS VALE ES UNO SOLO. De los 17 que solo marca Salesforce,
   * DIECISEIS no tienen fila de flags --nadie los miro nunca, ver
   * `b2bSinClasificar`-- y UNO si la tiene, con b2b=false. Ese unico prestamo
   * es el unico donde alguien miro y dijo que no: vale mas que los dieciseis
   * juntos, porque es la unica contradiccion de verdad. Mezclarlo con ellos lo
   * entierra.
   */
  b2bDiscrepa: boolean;
  /**
   * Salesforce dice B2B y NADIE lo ha clasificado a mano todavia.
   *
   * No es una discrepancia -- no hay dos opiniones, hay una -- pero tampoco es
   * un prestamo resuelto: es COLA DE TRABAJO, y es justo lo que la casilla de
   * clasificacion existe para atender. Son 16 sobre los 494.
   *
   * Si desaparecieran dentro de "ninguno" nadie sabria que hay dieciseis
   * prestamos que Salesforce considera B2B y que no ha revisado ni una persona.
   * Cuando se clasifiquen pasaran a `b2bDiscrepa` o a acuerdo, y esta categoria
   * se vaciara sola.
   */
  b2bSinClasificar: boolean;
  /**
   * El origen del lead, de Encompass.
   *
   * Sustituye a `lead_source_lo` del archivo, que traia 103 residuos de captura
   * --Encompass Integration 47, vacios 46, B2B Strategy 4, Referral y External
   * Referral-- que esta version no tiene. Es el motivo por el que el asterisco
   * de la cabecera se apaga: estaba atado al origen del dato, no al dato.
   */
  leadSource: string | null;
}

type Fila = Record<string, unknown>;

const MESES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * De ("July", 2026) al rango [2026-07-01, 2026-08-01).
 *
 * Medio abierto a proposito: `closing_month` es un date y un `lte` al ultimo
 * dia del mes se come o se deja fuera el dia 31 segun el mes, que es la clase
 * de fallo que aparece en tres meses del año y no en los otros nueve.
 *
 * Devuelve null cuando falta cualquiera de los dos, que significa "todos los
 * periodos". Un mes sin año no acota nada util y pedirlo es casi siempre un
 * error de quien llama, pero fallar aqui tumbaria la pantalla por un filtro:
 * se ignora y se devuelve todo, que es el comportamiento visible y corregible.
 */
function rangoDelMes(month: string | null, year: number | null) {
  if (!month || !year) return null;
  const i = MESES.findIndex((m) => m.toLowerCase() === month.trim().toLowerCase());
  if (i < 0) return null;
  const dd = (n: number) => String(n).padStart(2, "0");
  return {
    desde: `${year}-${dd(i + 1)}-01`,
    hasta: i === 11 ? `${year + 1}-01-01` : `${year}-${dd(i + 2)}-01`,
  };
}

/**
 * Los prestamos cerrados que cuentan para la division, con sus flags manuales.
 *
 * `month` y `year` son opcionales a proposito: el modulo de P&L por Loan
 * Officer pregunta por todos los periodos, porque "cuanto produce y cuanto
 * cuesta esta persona" solo tiene sentido a lo largo del tiempo.
 */
export async function getClosedLoans(opts: {
  month?: string | null;
  year?: number | null;
  branches?: string[] | null;
} = {}): Promise<ClosedLoan[]> {
  const ar = createServerClient("activity_report");
  const fd = createServerClient("finance_division");

  // Paginado: un select sin rango se corta en 1000 filas en este proyecto. El
  // `order` explicito es lo que lo hace determinista -- sin el, dos paginas
  // pueden traer la misma fila y perderse otra.
  const filas: Fila[] = [];
  for (let i = 0; ; i += 1000) {
    let q = ar
      .from("loan_records_v2")
      .select(
        "loan_number,borrower_name,loan_officer,loan_officer_person_code,branch," +
          "total_loan_amount,closing_month,strategy,is_b2b,lead_source",
      )
      .eq("is_closed", true)
      .eq("counts_for_division", true);
    if (opts.branches?.length) q = q.in("branch", opts.branches);
    /*
     * ⚠ EL PERIODO SE PIDE POR NOMBRE Y EL ESPEJO LO GUARDA COMO FECHA.
     * `loan_officials` tenia `month` ("July") y `year` (2026) como columnas
     * sueltas; aqui es `closing_month`, un date. La conversion vive en este
     * unico sitio y no en cada ruta, que es medio motivo de que exista este
     * archivo.
     */
    const rango = rangoDelMes(opts.month ?? null, opts.year ?? null);
    if (rango) q = q.gte("closing_month", rango.desde).lt("closing_month", rango.hasta);
    const { data, error } = await q.order("loan_number", { ascending: true }).range(i, i + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    filas.push(...(data as unknown as Fila[]));
    if (data.length < 1000) break;
  }

  const numeros = filas.map((r) => String(r.loan_number)).filter(Boolean);
  const flags = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < numeros.length; i += 200) {
    const trozo = numeros.slice(i, i + 200);
    const { data } = await fd
      .from("loan_manual_flags")
      .select("loan_number,b2b,support_on_demand,processing")
      .in("loan_number", trozo);
    for (const r of data ?? []) flags.set(String(r.loan_number), r);
  }

  return filas.map((r) => {
    const f = flags.get(String(r.loan_number));
    const b2bSalesforce = r.is_b2b === true;
    const b2bManual = f ? f.b2b === true : null;
    return {
      loanNumber: String(r.loan_number),
      borrowerName: (r.borrower_name as string) ?? null,
      loanOfficer: (r.loan_officer as string) ?? null,
      personCode: (r.loan_officer_person_code as string) ?? null,
      branch: (r.branch as string) ?? null,
      loanAmount: r.total_loan_amount == null ? null : Number(r.total_loan_amount),
      closingMonth: (r.closing_month as string) ?? null,
      strategy: (r.strategy as string) ?? null,
      b2bSalesforce,
      b2bManual,
      supportOnDemand: f ? f.support_on_demand === true : null,
      processing: f ? f.processing === true : null,
      // Sin fila de flags no hay con que discrepar: null no es "no".
      b2bDiscrepa: b2bManual !== null && b2bManual !== b2bSalesforce,
      b2bSinClasificar: b2bSalesforce && b2bManual === null,
      leadSource: (r.lead_source as string) ?? null,
    };
  });
}
