import type { NextConfig } from "next";
// The build gate below needs to know the active price provider's licence. The
// registry is side-effect-free to import (it only defines provider objects),
// so importing it here is safe at config-load time and does not open the DB.
import { getPriceProvider } from "./src/lib/providers/registry";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module — it must not be bundled by Turbopack/webpack
  // or `next build` fails to resolve the .node binary at runtime.
  serverExternalPackages: ["better-sqlite3"],

  // A long-running `next dev` holds locks on .next, which makes `next build`
  // fail when it tries to clear the cache. NEXT_DIST_DIR lets a build run
  // alongside it. Unset in normal use.
  ...(process.env.NEXT_DIST_DIR
    ? { distDir: process.env.NEXT_DIST_DIR }
    : {}),
};

// ---------------------------------------------------------------------------
// Build gate — launch readiness switch.
//
// We publish market-data prices. Those prices may only be shown publicly if the
// active provider's licence is "display-permitted" (see docs/LICENSING.md and
// src/lib/providers/licences.ts). While every provider is "unlicensed" — which
// is the correct current value, because no display licence has been read and
// recorded — a production build MUST fail. This is deliberate: it is the single
// point that stops unlicensed data reaching a public deployment. Dev builds are
// unaffected (NODE_ENV !== "production"), so development never blocks on it.
// ---------------------------------------------------------------------------
if (process.env.NODE_ENV === "production") {
  try {
    const priceProvider = getPriceProvider();
    if (priceProvider.licence !== "display-permitted") {
      throw new Error(
        `Price provider "${priceProvider.name}" is licensed "${priceProvider.licence}". ` +
          `Public display requires a display-permitted plan. See docs/LICENSING.md.`
      );
    }
  } catch (err) {
    // Either the provider is unlicensed or it could not be resolved at all.
    // Both must block a public build rather than ship unlicensed data.
    throw new Error(
      `Build blocked: the market-data price provider is not licensed for public ` +
        `display. Set PRICE_PROVIDER to a display-permitted provider (after recording ` +
        `its licence evidence in src/lib/providers/licences.ts) or see docs/LICENSING.md. ` +
        `(${err instanceof Error ? err.message : String(err)})`
    );
  }
}

export default nextConfig;
