import { defineConfig } from "vitest/config";

const packages = ["core", "catalog", "cli", "agent", "office"];

export default defineConfig({
  test: {
    projects: packages.map((pkg) => ({
      test: {
        name: pkg,
        root: `packages/${pkg}`,
        include: ["src/**/*.test.ts"],
      },
    })),
  },
});
