import type { Metadata } from "next";
import Link from "next/link";
import ProcessingIndicator from "./components/ProcessingIndicator";
import "./globals.css";

export const metadata: Metadata = {
  title: "VDR Auditor",
  description: "Due-diligence workspace: matters, review documents, and findings.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-slate-50 text-slate-900 antialiased">
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
            <Link
              href="/"
              className="flex items-center gap-2 rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-800"
            >
              <span
                aria-hidden="true"
                className="flex h-6 w-6 items-center justify-center rounded bg-slate-900 text-xs font-semibold text-white"
              >
                V
              </span>
              <span className="font-semibold tracking-tight">VDR Auditor</span>
            </Link>
            <nav aria-label="Primary">
              <Link
                href="/"
                className="rounded px-1 py-1 text-sm font-medium text-blue-800 hover:text-blue-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-800"
              >
                Matters
              </Link>
            </nav>
          </div>
        </header>
        {children}
        <ProcessingIndicator />
      </body>
    </html>
  );
}
