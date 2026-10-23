import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packages = ["core", "catalog", "cli", "agent", "office"];

export default defineConfig({
  test: {
    projects: [
      ...packages.map((pkg) => ({
        // Packages import each other as compiled libs; tests use the sources so they need no build first.
        resolve: {
          alias: {
            "@outstaff/core": fileURLToPath(new URL("packages/core/src/index.ts", import.meta.url)),
          },
        },
        test: {
          name: pkg,
          root: `packages/${pkg}`,
          include: ["src/**/*.test.ts"],
        },
      })),
      { test: { name: "scripts", root: "scripts", include: ["*.test.ts"] } },
      { test: { name: "docs", root: "docs", include: ["scripts/**/*.test.mjs"] } },
    ],
  },
});
