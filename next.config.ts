import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module — it must not be bundled by Turbopack/webpack
  // or `next build` fails to resolve the .node binary at runtime.
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
