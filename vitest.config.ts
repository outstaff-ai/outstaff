import { defineConfig } from "vitest/config";

// Tests run on the TypeScript sources, without a build: workspace packages (exports) and `#/` imports resolve through
// their "@outstaff/source" condition. A custom list replaces Vite's default for the server, so the rest repeats it.
const conditions = ["@outstaff/source", "module", "node", "development|production"];

// The event pipeline proof of concept (decision 0016) is held to the same rule as the integrations.
const EVENT_PIPELINE = [
  "packages/office/src/pipeline/**/*.ts",
  "packages/office/src/store/sql/traces.ts",
  "packages/office/src/store/migrations/0006_pipeline_traces.ts",
  "packages/office/src/store/sql/refs.ts",
  "packages/office/src/store/migrations/0009_work_item_refs.ts",
  "packages/office/src/refs/**/*.ts",
  "packages/office/src/wake-context/**/*.ts",
  "packages/core/src/config/pipeline.ts",
  "packages/cli/src/commands/explain.ts",
  "packages/office/src/link/**/*.ts",
  "packages/office/src/office-link.ts",
  "packages/protocol/src/link/**/*.ts",
  "packages/core/src/acts/**/*.ts",
  "packages/office/src/scheduler/enqueue.ts",
  "packages/office/src/chat/event.ts",
  "packages/office/src/chat/session.ts",
  "packages/office/src/office-chat.ts",
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
      // and statements, file by file. Tests and their helpers (`__tests__`) are not measured.
      provider: "v8",
      include: ["integrations/*/*/src/**/*.ts", ...EVENT_PIPELINE],
      exclude: ["**/__tests__/**"],
      reporter: ["text-summary", "json-summary"],
      thresholds: { perFile: true, lines: 100, branches: 100, functions: 100, statements: 100 },
    },
    projects: [
      ...packages.map((pkg) => ({
        ssr: { resolve: { conditions } },
        test: {
          name: pkg,
          root: `packages/${pkg}`,
          include: ["src/**/__tests__/**/*.test.ts"],

          // Office test files share one Postgres database when OUTSTAFF_TEST_POSTGRES_URL is set.
          ...(pkg === "office" ? { fileParallelism: false } : {}),
        },
      })),
      ...integrations.map((dir) => ({
        ssr: { resolve: { conditions } },
        test: {
          name: `integration.${dir.replace("/", ".")}`,
          root: `integrations/${dir}`,
          include: ["src/**/__tests__/**/*.test.ts"],
        },
      })),
      // The scripted runtime of the end-to-end test reads the agent's prompt, so it tests against the agent's source.
      {
        ssr: { resolve: { conditions } },
        test: { name: "e2e", root: "e2e", include: ["**/src/**/__tests__/**/*.test.ts"] },
      },
      { test: { name: "scripts", root: "scripts", include: ["__tests__/*.test.ts"] } },
      { test: { name: "docs", root: "docs", include: ["scripts/**/__tests__/**/*.test.mjs"] } },
    ],
  },
});
