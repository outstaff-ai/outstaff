import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const core = (path: string) => fileURLToPath(new URL(`packages/core/src/${path}`, import.meta.url));

// Adapter packages test against the source of core, so tests and typecheck run without a prior build.
const coreAlias = [
  { find: /^@outstaff\/core\/contracts$/, replacement: core("contracts/index.ts") },
  { find: /^@outstaff\/core\/fakes$/, replacement: core("fakes/index.ts") },
  { find: /^@outstaff\/core$/, replacement: core("index.ts") },
];

const packages = ["core", "catalog", "cli", "agent", "office"];
const adapters = ["vcs-github", "runtime-agent-sdk", "chat-slack"];

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
      ...adapters.map((pkg) => ({
        resolve: { alias: coreAlias },
        test: { name: pkg, root: `packages/${pkg}`, include: ["src/**/*.test.ts"] },
      })),
      { test: { name: "scripts", root: "scripts", include: ["*.test.ts"] } },
      { test: { name: "docs", root: "docs", include: ["scripts/**/*.test.mjs"] } },
    ],
  },
});
