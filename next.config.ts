import type { NextConfig } from "next";

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

export default nextConfig;
