import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without types
import { misplacedHelpers, misplacedTests } from "../tests-layout.mjs";

describe("tests layout", () => {
  it("flags test files outside a __tests__ folder", () => {
    expect(
      misplacedTests([
        "packages/core/src/config/__tests__/schema.test.ts",
        "packages/core/src/config/schema.test.ts",
        "docs/scripts/__tests__/llms.test.mjs",
        "scripts/versions.test.mjs",
        "packages/core/src/config/schema.ts",
      ]),
    ).toEqual(["packages/core/src/config/schema.test.ts", "scripts/versions.test.mjs"]);
  });

  it("flags files outside __tests__ and the public kits that import vitest", () => {
    const files: Record<string, string> = {
      "packages/office/src/store/contract.ts": 'import { describe } from "vitest";\n',
      "packages/agent/src/tools/testing.ts": "export const x = await import('vitest');\n",
      "integrations/chat/acme/src/testing/fake.ts": 'import type { Mock } from "vitest";\n',
      "packages/office/src/store/__tests__/contract.ts": 'import { describe } from "vitest";\n',
      "integrations/chat/acme/src/__tests__/support/fake.ts": 'import { vi } from "vitest";\n',
      "packages/core/src/contracts/chat.ts": 'import { describe } from "vitest";\n',
      "testing/acme/src/harness.ts": 'import { expect } from "vitest";\n',
      "testing/acme/scripts/seed.ts": 'import { expect } from "vitest";\n',
      "vitest.config.ts": 'import { defineConfig } from "vitest/config";\n',
      "packages/core/src/index.ts": 'export * from "./config/index.js";\n',
      "scripts/tests-layout.mjs": 'import "vitest";\n',
    };

    expect(misplacedHelpers(Object.keys(files), (file: string) => files[file])).toEqual([
      "packages/office/src/store/contract.ts",
      "packages/agent/src/tools/testing.ts",
      "integrations/chat/acme/src/testing/fake.ts",
      "testing/acme/scripts/seed.ts",
    ]);
  });
});
