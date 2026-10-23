import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { buildContext } from "./context.js";
import { parseTeamConfig } from "../config/parse.js";
import { CatalogError, type CatalogIssue } from "./codes.js";
import { loadCatalog } from "./load.js";
import { render } from "./template.js";
import { parse } from "yaml";
import { readAcmeTeam } from "../testing/fixtures.js";

const CATALOG_PKG = fileURLToPath(new URL("../../../catalog", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "outstaff-catalog-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
const GOOD_ROLE =
  "name: dev\ntitle: Dev\nsummary: Writes code.\ntoolset: code\npermissions: code\n";

/** Writes a catalog from {relative path: text}; adds a version unless given. */
const make = (files: Record<string, string>): string => {
  const dir = join(root, `c${n++}`);
  for (const [rel, text] of Object.entries({ "package.json": '{"version":"1.2.3"}', ...files })) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }

  return dir;
};

const role = (name: string, yaml = GOOD_ROLE.replace("name: dev", `name: ${name}`)) => ({
  [`roles/${name}/role.yaml`]: yaml,
  [`roles/${name}/SKILL.md`]: "skill",
});

const issuesOf = (dir: string, opts = {}): CatalogIssue[] => {
  try {
    loadCatalog(dir, opts);
  } catch (e) {
    if (e instanceof CatalogError) {
      return e.issues;
    }

    throw e;
  }

  throw new Error("expected load to fail");
};

describe("loadCatalog on the example role", () => {
  const catalog = loadCatalog(CATALOG_PKG);
  it("reads the version, role fields and defaults", () => {
    expect(catalog.version).toBe("0.0.0");
    const r = catalog.roles.example;
    expect(r).toMatchObject({
      title: "Example Role",
      toolset: "base",
      permissions: "readonly",
      needs: ["tracker.issues"],
      optional_needs: ["knowledge.docs"],
      default_model: "example-model",
    });

    expect(r?.files).toEqual({ skill: "SKILL.md" });
    expect(r?.modes).toEqual([
      { name: "review", when: "A pull request needs a second pair of eyes." },
    ]);

    expect(Object.keys(catalog.process)).toEqual(["example-lifecycle"]);
  });

  it("renders the example skill for the acme team", () => {
    const parsed = parseTeamConfig(parse(readAcmeTeam()));
    if (!parsed.ok) {
      throw new Error("acme invalid");
    }

    const ctx = buildContext(parsed.config, { roles: Object.keys(catalog.roles) });
    const out = render(catalog.roles.example!.skill.text, ctx, {
      file: catalog.roles.example!.skill.file,
    });

    expect(out).toContain("The acme team works on Acme Shop.");
    expect(out).toContain("The main repository is shop.");
    expect(out).toContain("- 0: shop\n- 1: infra");
  });
});

describe("loadCatalog errors", () => {
  it("accepts a minimal catalog and a version option", () => {
    expect(loadCatalog(make(role("dev"))).roles.dev?.skill.text).toBe("skill");
    expect(
      loadCatalog(make({ "package.json": "{}", ...role("dev") }), { version: "9.9.9" }).version,
    ).toBe("9.9.9");
  });

  it("rejects a directory that is not a catalog", () => {
    expect(issuesOf(join(root, "missing"))[0]).toMatchObject({ code: "catalog.not_found" });
  });

  it("accepts a catalog with only some folders", () => {
    const c = loadCatalog(make({ "references/r.md": "ref" }));
    expect(Object.keys(c.roles)).toEqual([]);
    expect(Object.keys(c.references)).toEqual(["r"]);
    expect(Object.keys(loadCatalog(make({})).roles)).toEqual([]);
  });

  it("requires a version", () => {
    expect(issuesOf(make({ "package.json": "{}", ...role("dev") }))[0]?.code).toBe(
      "catalog.version_missing",
    );
  });

  it("locates yaml syntax errors", () => {
    const [i] = issuesOf(make(role("dev", "name: dev\ntitle: a: b\n")));
    expect(i).toMatchObject({ code: "catalog.yaml_syntax", line: 2 });
    expect(i?.file).toMatch(/roles\/dev\/role\.yaml$/);
  });

  it("locates schema errors by line", () => {
    const issues = issuesOf(
      make(
        role(
          "dev",
          GOOD_ROLE + "needs: [nope.thing]\nbogus: 1\n".replace("needs: [nope.thing]\n", ""),
        ),
      ),
    );

    expect(issues[0]).toMatchObject({ code: "catalog.unknown_key", line: 6 });
    const bad = issuesOf(make(role("dev", GOOD_ROLE.replace("toolset: code", "toolset: laser"))));
    expect(bad[0]).toMatchObject({ code: "catalog.invalid_value", line: 4 });
    const cap = issuesOf(
      make(role("dev", GOOD_ROLE + "needs:\n  - tracker.issues\n  - nope.thing\n")),
    );

    expect(cap[0]).toMatchObject({ code: "catalog.invalid_value", line: 8 });
  });

  it("checks the name against the directory", () => {
    expect(
      issuesOf(make(role("dev", GOOD_ROLE.replace("name: dev", "name: other"))))[0],
    ).toMatchObject({ code: "catalog.name_mismatch", line: 1 });
  });

  it("reports a missing role.yaml and missing md files", () => {
    expect(issuesOf(make({ "roles/x/SKILL.md": "s" }))[0]?.code).toBe("catalog.missing_file");
    const i = issuesOf(make({ "roles/dev/role.yaml": GOOD_ROLE }));
    expect(i[0]).toMatchObject({ code: "catalog.missing_file" });
    expect(i[0]?.message).toContain("skill");
  });

  it("checks extends for unknown roles and cycles", () => {
    const unknown = issuesOf(make({ ...role("dev", GOOD_ROLE + "extends: [ghost]\n") }));
    expect(unknown[0]).toMatchObject({ code: "catalog.unknown_extends", line: 6 });
    const cycle = issuesOf(
      make({
        ...role("a", GOOD_ROLE.replace("name: dev", "name: a") + "extends: [b]\n"),
        ...role("b", GOOD_ROLE.replace("name: dev", "name: b") + "extends: [a]\n"),
      }),
    );

    expect(cycle.some((i) => i.code === "catalog.extends_cycle")).toBe(true);
    expect(issuesOf(make(role("dev", GOOD_ROLE + "extends: [dev]\n")))[0]?.code).toBe(
      "catalog.extends_cycle",
    );
  });

  it("reports template syntax errors in any markdown file", () => {
    const i = issuesOf(
      make({
        ...role("dev"),
        "process/p.md": "line\n{{#if x}}\nno end\n",
        "references/r.md": "{{ oops",
      }),
    );

    expect(i.map((x) => [x.code, x.line])).toEqual([
      ["catalog.unbalanced_block", 2],
      ["catalog.unclosed_tag", 1],
    ]);

    expect(i[0]?.file).toMatch(/process\/p\.md$/);
  });

  it("loads references and templates and ignores profiles", () => {
    const c = loadCatalog(
      make({
        ...role("dev"),
        "references/r.md": "r",
        "templates/t.md": "t",
        "profiles/x.yaml": "anything",
      }),
    );

    expect(Object.keys(c.references)).toEqual(["r"]);
    expect(Object.keys(c.templates)).toEqual(["t"]);
  });
});
