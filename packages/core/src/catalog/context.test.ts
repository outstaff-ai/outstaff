import { describe, expect, it } from "vitest";
import { parseTeamConfig } from "../config/parse.js";
import { readAcmeTeam } from "../testing/fixtures.js";
import { parse } from "yaml";
import { buildPersonContext, buildTeamContext } from "./context.js";
import { render } from "./template.js";

const acme = (() => {
  const r = parseTeamConfig(parse(readAcmeTeam()));
  if (!r.ok) {
    throw new Error(JSON.stringify(r.issues));
  }

  return r.config;
})();

describe("buildPersonContext", () => {
  const ctx = buildPersonContext(acme, "mira", {
    roles: ["pm", "tester"],
    links: { issue: "https://t.example/{key}" },
    defaultModels: { architect: "m1" },
  });

  it("describes team, person and repos", () => {
    expect(ctx.team).toEqual({ name: "acme", product: "Acme Shop" });
    expect(ctx.person).toMatchObject({
      handle: "mira",
      name: "Mira Okafor",
      pronouns: "she/her",
      role: "architect",
      model: "m1",
    });

    expect(ctx.repos.list.map((r) => r.name)).toEqual([
      "shop",
      "infra",
      "design-system",
      "docs-site",
    ]);

    expect(ctx.repos.primary?.name).toBe("shop");
  });

  it("groups people by role, including known empty roles", () => {
    expect(ctx.people.byRole.developer?.map((p) => p.handle)).toEqual(["sam", "noor"]);
    expect(ctx.people.byRole.tester).toEqual([]);
    expect(ctx.people.list).toHaveLength(8);
  });

  it("reports integrations, links and policies", () => {
    expect(ctx.integrations.has).toMatchObject({ tracker: true, vcs: true, mail: false });
    expect(ctx.integrations.adapter).toMatchObject({ tracker: "itsaplan", mail: "" });
    expect(ctx.links).toEqual({ issue: "https://t.example/{key}", pr: "", doc: "" });
    expect(ctx.policies.messages).toEqual({
      max_lines: 3,
      always_link: true,
      omit: ["ci", "mergeability", "hashes"],
    });
  });

  it("rejects an unknown handle", () => {
    expect(() => buildPersonContext(acme, "nobody")).toThrow(/Unknown person "nobody"/);
  });

  it("renders a template end to end and keeps typos strict", () => {
    const t =
      "{{person.name}} on {{team.product}}: {{#each people.byRole.developer}}{{this.handle}} {{/each}}{{#if integrations.has.mail}}mail{{/if}}";

    expect(render(t, ctx)).toBe("Mira Okafor on Acme Shop: sam noor ");
    expect(() => render("{{#each people.byRole.nobody}}x{{/each}}", ctx, { file: "s.md" })).toThrow(
      /unknown_placeholder/,
    );

    expect(() => render("{{integrations.has.tracer}}", ctx)).toThrow(/unknown_placeholder/);
  });

  it("uses null for a missing primary repo", () => {
    const noPrimary = { ...acme, repos: acme.repos.map((r) => ({ ...r, kind: "other" as const })) };
    const c = buildTeamContext(noPrimary);
    expect(render("{{#if repos.primary}}p{{else}}none{{/if}}", c)).toBe("none");
  });
});

describe("buildTeamContext", () => {
  it("has no person, and does not depend on who is rendered", () => {
    const team = buildTeamContext(acme, { defaultModels: { architect: "m1" } });
    expect("person" in team).toBe(false);
    expect(render("{{#if team.name}}ok{{/if}}", team)).toBe("ok");
    expect(() => render("{{ person.name }}", team, { file: "s.md" })).toThrow(
      /unknown_placeholder/,
    );

    const { person: _, ...rest } = buildPersonContext(acme, "mira", {
      defaultModels: { architect: "m1" },
    });

    expect(rest).toEqual(team);
  });
});
