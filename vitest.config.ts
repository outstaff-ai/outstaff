import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packages = ["core", "catalog", "cli", "agent", "office"];
const src = (path: string) => fileURLToPath(new URL(`packages/core/src/${path}`, import.meta.url));

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
      {
        // Adapters test against core's source so `pnpm test` works before `pnpm build`.
        resolve: {
          alias: [
            { find: /^@outstaff\/core\/contracts$/, replacement: src("contracts/index.ts") },
            { find: /^@outstaff\/core\/fakes$/, replacement: src("fakes/index.ts") },
            { find: /^@outstaff\/core$/, replacement: src("index.ts") },
          ],
        },
        test: { name: "vcs-github", root: "packages/vcs-github", include: ["src/**/*.test.ts"] },
      },
      { test: { name: "scripts", root: "scripts", include: ["*.test.ts"] } },
      { test: { name: "docs", root: "docs", include: ["scripts/**/*.test.mjs"] } },
    ],
  },
});
