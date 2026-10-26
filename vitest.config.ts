import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const core = (path: string) => fileURLToPath(new URL(`packages/core/src/${path}`, import.meta.url));

// Adapter packages test against the source of core, so tests and typecheck run without a prior build.
const coreAlias = [
  { find: /^@outstaff\/core\/contracts$/, replacement: core("contracts/index.ts") },
  { find: /^@outstaff\/core\/fakes$/, replacement: core("fakes/index.ts") },
  { find: /^@outstaff\/core$/, replacement: core("index.ts") },
  {
    find: /^@outstaff\/protocol$/,
    replacement: fileURLToPath(new URL("packages/protocol/src/index.ts", import.meta.url)),
  },
  {
    find: /^@outstaff\/agent$/,
    replacement: fileURLToPath(new URL("packages/agent/src/index.ts", import.meta.url)),
  },
  {
    find: /^@outstaff\/integration\.vcs\.github$/,
    replacement: fileURLToPath(new URL("integrations/vcs/github/src/index.ts", import.meta.url)),
  },
  {
    find: /^@outstaff\/integration\.tracker\.itsaplan$/,
    replacement: fileURLToPath(
      new URL("integrations/tracker/itsaplan/src/index.ts", import.meta.url),
    ),
  },
];

const packages = ["core", "catalog", "cli", "agent", "office", "protocol"];
// Adapter packages live in integrations/<port>/<vendor>; each is a project named like its package.
const integrations = [
  "vcs/github",
  "runtime/claude",
  "chat/slack",
  "tracker/itsaplan",
  "knowledge/itsaplan",
  "avatars/dicebear",
];

// Coverage is measured on the integrations, the code that talks to outside services. Each one has its own
// floor, raised to 100 as its tests are completed (#364). Test kits shipped for other packages are not measured.
const floors: Record<string, number> = {
  "vcs/github": 100,
  "runtime/claude": 100,
  "chat/slack": 100,
  "tracker/itsaplan": 100,
  "knowledge/itsaplan": 100,
  "avatars/dicebear": 100,
};

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: integrations.map((dir) => `integrations/${dir}/src/**/*.ts`),
      exclude: ["**/__tests__/**", "**/src/testing/**", "**/testing.ts", "**/contract.ts"],
      reporter: ["text-summary", "json-summary"],
      thresholds: Object.fromEntries(
        integrations.map((dir) => {
          const floor = floors[dir] ?? 100;
          return [
            `integrations/${dir}/src/**`,
            { lines: floor, branches: floor, functions: floor, statements: floor },
          ];
        }),
      ),
    },
    projects: [
      ...packages.map((pkg) => ({
        // Packages import each other as compiled libs; tests use the sources so they need no build first.
        resolve: { alias: coreAlias },
        test: {
          name: pkg,
          root: `packages/${pkg}`,
          include: ["src/**/__tests__/**/*.test.ts"],

          // Office test files share one Postgres database when OUTSTAFF_TEST_POSTGRES_URL is set.
          ...(pkg === "office" ? { fileParallelism: false } : {}),
        },
      })),
      ...integrations.map((dir) => ({
        resolve: { alias: coreAlias },
        test: {
          name: `integration.${dir.replace("/", ".")}`,
          root: `integrations/${dir}`,
          include: ["src/**/__tests__/**/*.test.ts"],
        },
      })),
      // The scripted runtime of the end-to-end test reads the agent's prompt, so it tests against the agent's source.
      {
        resolve: { alias: coreAlias },
        test: { name: "e2e", root: "e2e", include: ["**/src/**/__tests__/**/*.test.ts"] },
      },
      { test: { name: "scripts", root: "scripts", include: ["__tests__/*.test.ts"] } },
      { test: { name: "docs", root: "docs", include: ["scripts/**/__tests__/**/*.test.mjs"] } },
    ],
  },
});
