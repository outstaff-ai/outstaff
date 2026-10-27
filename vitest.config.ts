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
    find: /^@outstaff\/office$/,
    replacement: fileURLToPath(new URL("packages/office/src/index.ts", import.meta.url)),
  },
  // Private test kits (testing/*), from source. An adapter's own tests reach its kit through this alias only: the
  // kit depends on the adapter, so a dependency back would be a cycle.
  ...["core", "github", "itsaplan", "office", "agent"].map((kit) => ({
    find: new RegExp(`^@outstaff/testing\\.${kit}$`),
    replacement: fileURLToPath(new URL(`testing/${kit}/src/index.ts`, import.meta.url)),
  })),
  {
    find: /^@outstaff\/agent$/,
    replacement: fileURLToPath(new URL("packages/agent/src/index.ts", import.meta.url)),
  },
  {
    find: /^@outstaff\/integration\.vcs\.github$/,
    replacement: fileURLToPath(new URL("integrations/vcs/github/src/index.ts", import.meta.url)),
  },
  {
    find: /^@outstaff\/integration\.shared\.itsaplan$/,
    replacement: fileURLToPath(
      new URL("integrations/shared/itsaplan/src/index.ts", import.meta.url),
    ),
  },
  {
    find: /^@outstaff\/integration\.tracker\.itsaplan$/,
    replacement: fileURLToPath(
      new URL("integrations/tracker/itsaplan/src/index.ts", import.meta.url),
    ),
  },
];

// The event pipeline proof of concept (decision 0016) is held to the same rule as the integrations.
const EVENT_PIPELINE = [
  "packages/office/src/pipeline/**/*.ts",
  "packages/office/src/store/sql/traces.ts",
  "packages/office/src/store/migrations/0006_pipeline_traces.ts",
  "packages/core/src/config/pipeline.ts",
  "packages/cli/src/commands/explain.ts",
  "packages/office/src/link/**/*.ts",
  "packages/office/src/office-link.ts",
  "packages/protocol/src/link/**/*.ts",
  "packages/core/src/acts/**/*.ts",
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
  "shared/itsaplan",
];

export default defineConfig({
  test: {
    coverage: {
      // Every integration, including new ones, and the event pipeline are held to 100% of lines, branches, functions
      // and statements, file by file. Test kits shipped for other packages are not measured.
      provider: "v8",
      include: ["integrations/*/*/src/**/*.ts", ...EVENT_PIPELINE],
      exclude: ["**/__tests__/**", "**/src/testing/**", "**/testing.ts", "**/contract.ts"],
      reporter: ["text-summary", "json-summary"],
      thresholds: { perFile: true, lines: 100, branches: 100, functions: 100, statements: 100 },
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
