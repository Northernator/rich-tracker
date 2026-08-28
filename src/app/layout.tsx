import type { Metadata } from "next";
import { Inter, Playfair_Display, JetBrains_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

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
  description: "Multi-source billionaire net-worth estimates with consistency bands. Shows what Forbes and Bloomberg disagree on, and what fraction is verifiable.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${playfair.variable} ${jetbrains.variable}`}>
      <body className="min-h-screen bg-bg text-fg font-sans">
        <header className="border-b border-border">
          <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
            <Link href="/" className="font-serif text-xl font-semibold tracking-tight text-fg hover:text-accent transition-colors">
              Track the Rich
            </Link>
            <nav className="flex gap-6 text-sm">
              <Link href="/" className="text-fg-muted hover:text-fg transition-colors">Rankings</Link>
              <Link href="/about" className="text-fg-muted hover:text-fg transition-colors">About</Link>
            </nav>
          </div>
        </header>
        <main>{children}</main>
        <footer className="border-t border-border mt-16">
          <div className="max-w-6xl mx-auto px-6 py-8 text-xs text-fg-faint">
            <p>Data for demonstration. Sources shown are mock estimates to illustrate the consistency-band concept.</p>
          </div>
        </footer>
      </body>
    </html>
  );
}
