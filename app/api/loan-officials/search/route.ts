import { NextRequest, NextResponse } from "next/server";
import { getClosedLoans } from "@/lib/loan-source";

const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

export type LoanOfficialSearchResult = {
  loan_number: string;
  borrower_name: string | null;
  loan_officer: string | null;
  month: string | null;
  year: number | null;
};

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") ?? "").trim();
  const prefix = (searchParams.get("prefix") ?? "").trim();
  const limit = Math.min(Number(searchParams.get("limit") ?? "15"), 50);

  if (!q && !prefix) {
    return NextResponse.json([]);
  }

  /*
   * Busca en el espejo, no en el archivo. Importa aqui mas que en otras rutas:
   * esta es la que usa el buscador de Transactions para resolver un numero de
   * prestamo a mano, y contra el archivo NO ENCONTRARIA los cierres de agosto y
   * septiembre -- devolveria "no existe" de prestamos que si existen, que es
   * peor que no tener buscador.
   */
  const cerrados = await getClosedLoans();

  const coincide = (l: { loanNumber: string; borrowerName: string | null }) => {
    if (prefix) return l.loanNumber.toLowerCase().startsWith(prefix.toLowerCase());
    if (/^\d+$/.test(q)) return l.loanNumber.toLowerCase().startsWith(q.toLowerCase());
    return (l.borrowerName ?? "").toLowerCase().includes(q.toLowerCase());
  };

  const out: LoanOfficialSearchResult[] = cerrados
    .filter(coincide)
    .sort((a, b) => a.loanNumber.localeCompare(b.loanNumber))
    .slice(0, limit)
    .map((l) => {
      const [y, m] = (l.closingMonth ?? "").split("-");
      return {
        loan_number: l.loanNumber,
        borrower_name: l.borrowerName,
        loan_officer: l.loanOfficer,
        month: m ? MONTH_NAMES[Number(m) - 1] ?? null : null,
        year: Number(y) || null,
      };
    });

  return NextResponse.json(out);
}
