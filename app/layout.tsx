import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/components/app-shell";

export const metadata: Metadata = {
  title: "Homesí Finance",
  description: "Cost center review and P&L category assignment for Supreme Lending",
  // Points at the copy already in public/ rather than a second one under app/,
  // so the sidebar mark and the tab icon can never drift apart.
  icons: { icon: "/HOMESI_Icon_Home_Red.svg" },
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
