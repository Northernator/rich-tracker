import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next-build/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // `elite/` is a separate, self-contained project with its own package.json,
    // vite config and toolchain. `elite/dist` is its build output. It is not
    // part of this Next.js app and is already excluded in tsconfig.json —
    // linting it here just drowns real findings in minified bundle noise.
    "elite/**",
  ]),
]);

export default eslintConfig;
