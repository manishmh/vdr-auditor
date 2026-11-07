import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "VDR Auditor — M&A Due Diligence Data Room Auditor",
  description:
    "First-pass contract screening for due diligence teams. Evidence-backed candidate findings for human review — not legal advice.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col font-sans">
        <header className="border-b border-stone-200 bg-white">
          <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
            <Link href="/" className="flex items-baseline gap-3">
              <span className="font-display text-xl font-medium tracking-tight text-stone-900">
                VDR Auditor
              </span>
              <span className="hidden text-xs text-stone-500 sm:inline">M&amp;A due diligence</span>
            </Link>
            <span className="inline-flex items-center gap-1.5 text-xs text-stone-600">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden />
              Controlled pilot
            </span>
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6">{children}</main>
        <footer className="border-t border-stone-200 bg-white">
          <div className="mx-auto max-w-7xl px-4 py-4 text-xs leading-relaxed text-stone-600 sm:px-6">
            Due diligence assistance tool — not a substitute for legal advice. Candidate findings
            require verification by a qualified reviewer. Demo findings are synthetic and never came
            from a real legal review.
          </div>
        </footer>
      </body>
    </html>
  );
}
