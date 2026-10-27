import { describe, expect, it } from "vitest";
import { parseTeamConfig } from "#/config/parse.js";
import { readAcmeTeam } from "@outstaff/testing.core";
import { parse } from "yaml";
import { buildContext } from "#/catalog/context.js";
import { render } from "#/catalog/template.js";

const acme = (() => {
  const r = parseTeamConfig(parse(readAcmeTeam()));
  if (!r.ok) {
    throw new Error(JSON.stringify(r.issues));
  }

  return r.config;
})();

describe("buildContext", () => {
  const ctx = buildContext(acme, {
    roles: [
      { name: "pm", title: "Project Manager", summary: "Plans the work." },
      { name: "tester", title: "Tester", summary: "Tests it." },
      { name: "developer", title: "Developer", summary: "Writes code." },
    ],
    links: { issue: "https://t.example/{key}" },
  });

  it("describes team and repos", () => {
    expect(ctx.team).toEqual({ name: "acme", product: "Acme Shop" });
    expect(ctx.repos.list.map((r) => r.name)).toEqual([
      "shop",
      "infra",
      "design-system",
      "docs-site",
    ]);

    expect(ctx.repos.primary?.name).toBe("shop");
  });

  it("exposes each repo's checks", () => {
    expect(ctx.repos.has_checks).toBe(true);
    expect(ctx.repos.list.find((r) => r.name === "shop")?.checks).toEqual([
      "pnpm lint",
      "pnpm vitest related --run",
    ]);

    expect(ctx.repos.list.find((r) => r.name === "infra")?.checks).toEqual([]);
    const tpl =
      "{{#each repos.list}}{{#if this.checks}}{{this.name}}:{{#each this.checks}}[{{this}}]{{/each}};{{/if}}{{/each}}";

    expect(render(tpl, ctx)).toBe("shop:[pnpm lint][pnpm vitest related --run];");
  });

  it("exposes each repo's conventions and instructions, empty when absent", () => {
    expect(ctx.repos.list.every((r) => r.conventions === "" && r.instructions.length === 0)).toBe(
      true,
    );

    expect(ctx.repos.has_conventions).toBe(false);
  });

  it("groups people by role, including known empty roles", () => {
    expect(ctx.people.byRole.developer?.map((p) => p.handle)).toEqual(["sam", "noor"]);
    expect(ctx.people.byRole.tester).toEqual([]);
    expect(ctx.people.list).toHaveLength(8);
  });

  it("adds role title and summary to people and lists catalog roles", () => {
    expect(ctx.people.byRole.developer?.[0]).toMatchObject({
      role_title: "Developer",
      role_summary: "Writes code.",
    });

    const unknown = ctx.people.list.find((p) => p.role === "designer");
    expect(unknown).toMatchObject({ role_title: "", role_summary: "" });
    expect(ctx.roles.map((r) => r.name)).toEqual(["pm", "tester", "developer"]);
    expect(ctx.people.byRole.tester).toEqual([]);
    expect(ctx.roles[2]?.people.map((p) => p.handle)).toEqual(["sam", "noor"]);
    expect(render("{{#each roles}}{{this.title}};{{/each}}", ctx)).toBe(
      "Project Manager;Tester;Developer;",
    );
  });

  it("lists humans by name only, and flags default trust", () => {
    expect(ctx.humans.has).toBe(true);
    expect(ctx.humans.default_trust).toBe(false);
    expect(ctx.humans.list[0]).toEqual({ name: "Ada Admin" });
    const none = buildContext({ ...acme, humans: undefined });
    expect(none.humans).toEqual({ list: [], has: false, default_trust: true });
  });

  it("reports integrations, links and policies", () => {
    expect(ctx.integrations.has).toMatchObject({ tracker: true, vcs: true, avatars: true });
    expect(ctx.integrations.adapter).toMatchObject({ tracker: "itsaplan" });
    expect(ctx.links).toEqual({ issue: "https://t.example/{key}", pr: "", doc: "" });
    expect(ctx.policies.messages).toEqual({
      max_lines: 3,
      always_link: true,
      omit: ["ci", "mergeability", "hashes"],
    });
  });

  it("tells a template whether the team allows several pull requests per ticket", () => {
    expect(ctx.policies.tickets).toEqual({ many_prs: false });
    const many = buildContext({
      ...acme,
      policies: {
        ...acme.policies!,
        tickets: { prs_per_ticket: "many", start_moves_active: true },
      },
    });

    expect(many.policies.tickets).toEqual({ many_prs: true });
  });

  it("renders a template end to end and keeps typos strict", () => {
    const t =
      "{{team.name}} on {{team.product}}: {{#each people.byRole.developer}}{{this.handle}} {{/each}}{{#if integrations.has.avatars}}avatars{{/if}}";

    expect(render(t, ctx)).toBe("acme on Acme Shop: sam noor avatars");
    expect(() => render("{{#each people.byRole.nobody}}x{{/each}}", ctx, { file: "s.md" })).toThrow(
      /unknown_placeholder/,
    );

    expect(() => render("{{integrations.has.tracer}}", ctx)).toThrow(/unknown_placeholder/);
  });

  it("uses null for a missing primary repo", () => {
    const noPrimary = { ...acme, repos: acme.repos.map((r) => ({ ...r, kind: "other" as const })) };
    const c = buildContext(noPrimary);
    expect(render("{{#if repos.primary}}p{{else}}none{{/if}}", c)).toBe("none");
  });

  it("has no person; a person placeholder is a located error", () => {
    expect("person" in ctx).toBe(false);
    expect(() => render("a\n  {{ person.name }}", ctx, { file: "s.md" })).toThrow(
      /s\.md:2:3 catalog\.unknown_placeholder/,
    );
  });
});
