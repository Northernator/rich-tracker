import type { Metadata } from "next";
import { Inter, Playfair_Display, JetBrains_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { DATA_STATUS } from "@/lib/data-status";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const playfair = Playfair_Display({
  subsets: ["latin"],
  variable: "--font-serif",
  display: "swap",
  weight: ["600", "700"],
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Track the Rich — Global Billionaire Consensus Tracker",
  description: "Multi-source billionaire net-worth estimates with consistency bands.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${playfair.variable} ${jetbrains.variable}`}>
      <body className="min-h-screen bg-bg text-fg font-sans">
        {DATA_STATUS === "unverified" && (
          <div className="dev-banner">
            Development data — figures are not sourced. See{" "}
            <Link href="/about" className="underline">About</Link>.
          </div>
        )}
        <header className="border-b border-border">
          <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
            <Link href="/" className="font-serif text-xl font-semibold tracking-tight text-fg hover:text-accent transition-colors">
              Track the Rich
            </Link>
            <nav className="flex gap-6 text-sm">
              <Link href="/" className="text-fg-muted hover:text-fg transition-colors">Rankings</Link>
              <Link href="/equity" className="text-fg-muted hover:text-fg transition-colors">Equity</Link>
              <Link href="/ownership" className="text-fg-muted hover:text-fg transition-colors">Ownership</Link>
              <Link href="/globe" className="text-fg-muted hover:text-fg transition-colors">Globe</Link>
              <Link href="/events" className="text-fg-muted hover:text-fg transition-colors">Events</Link>
              <Link href="/about" className="text-fg-muted hover:text-fg transition-colors">About</Link>
            </nav>
          </div>
        </header>
        <main>{children}</main>
        <footer className="border-t border-border mt-16">
          <div className="max-w-6xl mx-auto px-6 py-8 text-xs text-fg-faint space-y-3">
            <p>
              Estimates are compiled from third-party sources. They are not authoritative
              and should not be treated as definitive statements of fact.
              See <Link href="/terms" className="text-fg-muted hover:text-fg transition-colors">Terms of Use</Link>
              {' '}and <Link href="/privacy" className="text-fg-muted hover:text-fg transition-colors">Privacy Policy</Link>.
            </p>
            <p>
              © {new Date().getFullYear()} Track the Rich. Open-source under MIT.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
