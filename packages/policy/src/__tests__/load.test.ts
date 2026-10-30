import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCustomPolicies } from "#/load.js";

const POLICY = `{ id: "%ID%", summary: "test", on: ["ticket.assigned"], decide: () => [] }`;

/** A team folder with policy modules, and an installed package. */
function teamDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ost-policies-"));
  const write = (file: string, text: string) => {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
  };

  write("policies/one.ts", `export const policy = ${POLICY.replace("%ID%", "one")} as const;\n`);
  write(
    "policies/many.mjs",
    `export const policies = [${POLICY.replace("%ID%", "two")}, ${POLICY.replace("%ID%", "three")}];\n`,
  );

  write("policies/none.mjs", "export const other = 1;\n");
  write("policies/bad.mjs", `export const policy = { id: "Bad" };\n`);
  write("policies/broken.mjs", "export const policy = ;\n");
  write(
    "node_modules/@acme/oncall/package.json",
    JSON.stringify({ name: "@acme/oncall", type: "module", exports: { default: "./index.js" } }),
  );

  write(
    "node_modules/@acme/oncall/index.js",
    `export const policy = ${POLICY.replace("%ID%", "oncall")};\n`,
  );

  return dir;
}

describe("loadCustomPolicies", () => {
  const dir = teamDir();

  it("loads a module of the team's repository, a list, and an installed package, with their settings", async () => {
    const loaded = await loadCustomPolicies(
      [
        { module: "./policies/one.ts", settings: { until: "2026-12-01" } },
        { module: join(dir, "policies/many.mjs") },
        { package: "@acme/oncall" },
      ],
      dir,
    );

    expect(loaded.issues).toEqual([]);
    expect(loaded.policies.map((p) => p.id)).toEqual(["one", "two", "three", "oncall"]);
    expect(loaded.policies[0]!.settings).toEqual({ until: "2026-12-01" });
    expect(loaded.policies[1]!.settings).toBeUndefined();
  });

  it("says which entry could not be loaded, exports no policy, or is not a policy", async () => {
    const loaded = await loadCustomPolicies(
      [
        { module: "./policies/none.mjs" },
        { module: "./policies/bad.mjs" },
        { module: "./policies/broken.mjs" },
        { module: "./policies/missing.mjs" },
        { package: "@acme/not-installed" },
        { package: "zod" },
      ],
      dir,
    );

    expect(loaded.policies).toEqual([]);
    expect(loaded.issues).toEqual([
      { index: 0, message: "./policies/none.mjs: exports no `policy` (or `policies` list)" },
      { index: 1, message: expect.stringMatching(/^\.\/policies\/bad\.mjs: not a policy: id: /) },
      {
        index: 2,
        message: expect.stringMatching(/^\.\/policies\/broken\.mjs: cannot be loaded: /),
      },
      {
        index: 3,
        message: expect.stringMatching(/^\.\/policies\/missing\.mjs: cannot be loaded: /),
      },
      { index: 4, message: expect.stringMatching(/^@acme\/not-installed: cannot be loaded: /) },
      // Not installed for the team: the office's own copy, which is no policy.
      { index: 5, message: "zod: exports no `policy` (or `policies` list)" },
    ]);
  });
});
