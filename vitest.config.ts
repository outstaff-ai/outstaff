import { defineConfig } from "vitest/config";

const packages = ["core", "catalog", "cli", "agent", "office"];

export default defineConfig({
  test: {
    projects: [
      ...packages.map((pkg) => ({
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
