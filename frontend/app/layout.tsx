import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VDR Auditor — Matters",
  description: "VDR Auditor matters, with frontend, backend API, and database health.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-white text-zinc-900 antialiased">{children}</body>
    </html>
  );
}
