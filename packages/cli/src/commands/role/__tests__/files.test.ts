import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fromStockRole, templateRole, titleOf } from "#/commands/role/files.js";

const stock = mkdtempSync(join(tmpdir(), "ost-role-files-"));
mkdirSync(join(stock, "roles", "reviewer"), { recursive: true });
writeFileSync(
  join(stock, "roles", "reviewer", "role.yaml"),
  "name: reviewer\ntitle: Reviewer\ntoolset: code\npermissions: code\n",
);

writeFileSync(join(stock, "roles", "reviewer", "SKILL.md"), "# Reviewer\n\nReviews code.\n");

describe("titleOf", () => {
  it("title-cases each dash-separated word", () => {
    expect(titleOf("data-engineer")).toBe("Data Engineer");
  });
});

describe("templateRole", () => {
  it("defaults to the base toolset and docs profile", () => {
    const files = templateRole("auditor", "Auditor", {});
    expect(files.yaml).toContain("toolset: base\npermissions: docs\n");
    expect(files.skill.startsWith("# Auditor\n")).toBe(true);
  });

  it("uses the given toolset and profile", () => {
    const files = templateRole("auditor", "Auditor", { toolset: "code", profile: "readonly" });
    expect(files.yaml).toContain("toolset: code\npermissions: readonly\n");
  });
});

describe("fromStockRole", () => {
  it("copies the stock role with the name and title replaced", () => {
    const files = fromStockRole(stock, "reviewer", "qa", "QA Engineer", {});
    expect(files).toEqual({
      yaml: "name: qa\ntitle: QA Engineer\ntoolset: code\npermissions: code\n",
      skill: "# QA Engineer\n\nReviews code.\n",
    });
  });

  it("overrides the toolset and profile when given", () => {
    const files = fromStockRole(stock, "reviewer", "qa", "QA", {
      toolset: "base",
      profile: "docs",
    });

    expect(typeof files === "string" ? files : files.yaml).toBe(
      "name: qa\ntitle: QA\ntoolset: base\npermissions: docs\n",
    );
  });

  it("explains an unknown or malformed stock role", () => {
    expect(fromStockRole(stock, "nobody", "qa", "QA", {})).toBe('No stock role "nobody".');
    expect(fromStockRole(stock, "../reviewer", "qa", "QA", {})).toBe(
      'No stock role "../reviewer".',
    );
  });
});
