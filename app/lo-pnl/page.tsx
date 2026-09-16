"use client";

import { LoPnlView } from "@/components/lo-pnl-view";

/**
 * P&L por Loan Officer, como pantalla propia.
 *
 * La tabla vive en `components/lo-pnl-view` porque existe en DOS sitios: aqui,
 * y como pestaña del modal de detalle de prestamos, donde enseña los loan
 * officers de esa sucursal. Dos copias serian dos definiciones de "cuanto
 * produce esta persona" separandose sin que nada falle.
 *
 * Sin `branch`: aqui se ven todos.
 */
export default function LoPnlPage() {
  return <LoPnlView />;
}
