import { describe, expect, it } from "vitest";
import { CatalogError } from "../codes.js";
import { render } from "../template.js";

const ctx = {
  team: { name: "acme", empty: "", none: null },
  list: [{ n: "a" }, { n: "b" }],
  words: ["x", "y"],
  nested: [{ items: ["p", "q"] }, { items: [] }],
  yes: true,
  no: false,
  zero: [],
};

const fails = (tpl: string, context: unknown = ctx) => {
  try {
    render(tpl, context, { file: "t.md" });
  } catch (e) {
    if (e instanceof CatalogError) {
      return e.issues;
    }

    throw e;
  }

  throw new Error("expected render to fail");
};

describe("render", () => {
  it("fills placeholders without escaping", () => {
    expect(render("Hi {{ team.name }} <b>&", ctx)).toBe("Hi acme <b>&");
    expect(render("[{{team.empty}}][{{team.none}}]", ctx)).toBe("[][]");
  });

  it("handles if/else and unless", () => {
    expect(
      render("{{#if yes}}A{{else}}B{{/if}}{{#if no}}A{{else}}B{{/if}}{{#if zero}}A{{/if}}", ctx),
    ).toBe("AB");

    expect(render("{{#unless no}}U{{/unless}}{{#unless yes}}V{{else}}W{{/unless}}", ctx)).toBe(
      "UW",
    );
  });

  it("iterates with this, this.field and @index", () => {
    expect(render("{{#each list}}{{@index}}={{this.n}};{{/each}}", ctx)).toBe("0=a;1=b;");
    expect(render("{{#each words}}{{this}},{{/each}}", ctx)).toBe("x,y,");
    expect(render("{{#each zero}}never{{/each}}done", ctx)).toBe("done");
  });

  it("nests blocks and reaches root paths inside each", () => {
    const t =
      "{{#each nested}}{{@index}}:{{#each this.items}}{{this}}{{/each}}{{#unless this.items}}-{{/unless}} {{team.name}}|{{/each}}";

    expect(render(t, ctx)).toBe("0:pq acme|1:- acme|");
    expect(render("{{#each list}}{{#if this.n}}{{this.n}}{{/if}}{{/each}}", ctx)).toBe("ab");
  });

  it("renders escaped braces literally", () => {
    expect(render("\\{{ team.name }} and {{team.name}}", ctx)).toBe("{{ team.name }} and acme");
  });

  it("drops block tags that sit alone on a line", () => {
    const t = "a\n{{#if yes}}\nb\n{{else}}\nc\n{{/if}}\nd\n";
    expect(render(t, ctx)).toBe("a\nb\nd\n");
    expect(render("x {{#if yes}}y{{/if}} z", ctx)).toBe("x y z");
  });
});

describe("render errors", () => {
  it("reports unknown placeholders with file:line:column", () => {
    const [issue, ...rest] = fails("ok\n  hi {{ team.nmae }}");
    expect(rest).toEqual([]);
    expect(issue).toMatchObject({
      code: "catalog.unknown_placeholder",
      file: "t.md",
      line: 2,
      column: 6,
    });
  });

  it("reports every unknown placeholder", () => {
    expect(fails("{{a}} {{b}}").map((i) => i.column)).toEqual([1, 7]);
  });

  it("treats an unknown path in if/unless/each as an error", () => {
    expect(fails("{{#if typo}}x{{/if}}")[0]?.code).toBe("catalog.unknown_placeholder");
    expect(fails("{{#unless typo}}x{{/unless}}")[0]?.code).toBe("catalog.unknown_placeholder");
    expect(fails("{{#each typo}}x{{/each}}")[0]?.code).toBe("catalog.unknown_placeholder");
  });

  it("rejects this and @index outside each, and unknown fields of this", () => {
    expect(fails("{{this}}")[0]?.code).toBe("catalog.unknown_placeholder");
    expect(fails("{{@index}}")[0]?.code).toBe("catalog.unknown_placeholder");
    expect(fails("{{#each list}}{{this.zzz}}{{/each}}")[0]?.code).toBe(
      "catalog.unknown_placeholder",
    );
  });

  it("rejects groups, lists and non-lists", () => {
    expect(fails("{{team}}")[0]?.code).toBe("catalog.not_scalar");
    expect(fails("{{words}}")[0]?.code).toBe("catalog.not_scalar");
    expect(fails("{{#each team}}x{{/each}}")[0]?.code).toBe("catalog.not_iterable");
  });

  it("rejects unbalanced blocks with positions", () => {
    expect(fails("a\n{{#if yes}}x")[0]).toMatchObject({
      code: "catalog.unbalanced_block",
      line: 2,
      column: 1,
    });

    expect(fails("{{/if}}")[0]?.code).toBe("catalog.unbalanced_block");
    expect(fails("{{#if yes}}{{/each}}")[0]).toMatchObject({
      code: "catalog.unbalanced_block",
      column: 12,
    });

    expect(fails("{{else}}")[0]?.code).toBe("catalog.unbalanced_block");
    expect(fails("{{#if yes}}{{else}}{{else}}{{/if}}")[0]?.code).toBe("catalog.unbalanced_block");
    expect(fails("{{#each list}}{{else}}{{/each}}")[0]?.code).toBe("catalog.unbalanced_block");
  });

  it("rejects unclosed tags and expressions", () => {
    expect(fails("x {{ team.name")[0]).toMatchObject({ code: "catalog.unclosed_tag", column: 3 });
    expect(fails("{{ a + b }}")[0]?.code).toBe("catalog.invalid_tag");
    expect(fails("{{ upper team.name }}")[0]?.code).toBe("catalog.invalid_tag");
    expect(fails("{{#if}}{{/if}}")[0]?.code).toBe("catalog.invalid_tag");
    expect(fails("{{#with x}}{{/with}}")[0]?.code).toBe("catalog.invalid_tag");
  });

  it("formats the error message as file:line:column code: message", () => {
    expect(() => render("{{x}}", {}, { file: "r.md" })).toThrow(
      /^r\.md:1:1 catalog\.unknown_placeholder: /,
    );
  });
});
