import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { connection } from "next/server";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: "SecWire", template: "%s · SecWire" },
  description: "Security news, deduplicated and enriched with CVE, KEV and EPSS data.",
  referrer: "strict-origin-when-cross-origin",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Every page renders per request: it reads Postgres and needs a fresh CSP nonce.
  await connection();
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <header className="border-b border-foreground/10">
          <nav className="mx-auto flex w-full max-w-7xl items-center gap-4 px-4 py-2 text-sm">
            <Link href="/" className="font-mono font-semibold tracking-tight">
              sec<span className="text-accent">wire</span>
            </Link>
            <Link href="/" className="text-muted hover:text-foreground">
              Feed
            </Link>
            <Link href="/admin" className="ml-auto text-muted hover:text-foreground">
              Admin
            </Link>
          </nav>
        </header>
        <div className="mx-auto w-full max-w-7xl flex-1 px-4 py-4">{children}</div>
      </body>
    </html>
  );
}
