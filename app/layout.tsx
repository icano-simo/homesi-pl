import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/components/app-shell";

export const metadata: Metadata = {
  title: "Homesí P&L",
  description: "Cost center review and P&L category assignment for Supreme Lending",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es">
      {/* Login renders its own full-page canvas, so the shell decides both the
          chrome and the background rather than the body forcing a colour.
          #FCFCFA is "New Day", the brand canvas. */}
      <body className="h-screen overflow-hidden bg-[#FCFCFA]">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
