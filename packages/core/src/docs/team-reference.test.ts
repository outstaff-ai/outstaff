import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderTeamYamlReference, renderValidationCodes } from "./team-reference.js";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const example = read("../../../../examples/acme/.outstaff/team.yaml");
const pages = "../../../../docs/src/content/docs/reference/";
const hint = "(run `pnpm --filter @outstaff/core run docs:schema`)";

describe("team.yaml reference", () => {
  it(`matches the committed page ${hint}`, () => {
    expect(read(`${pages}team-yaml.md`)).toBe(renderTeamYamlReference(example));
  });

  it("documents nested fields with defaults and allowed values", () => {
    const page = renderTeamYamlReference(example);
    expect(page).toContain("### people[].repos");
    expect(page).toContain("policies.messages.max_lines");
    expect(page).toContain("- Default: `3`");
    expect(page).toContain("`kanban`, `scrum`, `minimal`");
    expect(page).toContain("# Who the team is.");
  });
});

describe("validation codes reference", () => {
  it(`matches the committed page ${hint}`, () => {
    expect(read(`${pages}validation-codes.md`)).toBe(renderValidationCodes());
  });

  it("separates errors from warnings", () => {
    const page = renderValidationCodes();
    const [errors, warnings] = page.split("## Warnings");
    expect(errors).toContain("`people.unknown_repo`");
    expect(warnings).toContain("`trust.default`");
    expect(errors).not.toContain("`trust.default`");
  });
});
