import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACME_TEAM_FILE,
  DUPLICATE_HANDLE_TEAM,
  MISSING_REPOS_TEAM,
  UNKNOWN_REPO_GRANT_TEAM,
  YAML_SYNTAX_ERROR_TEAM,
} from "../../core/src/testing/fixtures.js";
import { renderCliReference } from "./reference.js";
import type { Context } from "./define.js";
import { run, version } from "./program.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "ost-cli-")));
let n = 0;

function project(name = `p${n++}`, team?: string) {
  const dir = join(root, name);
  mkdirSync(join(dir, ".outstaff"), { recursive: true });
  if (team !== undefined) writeFileSync(join(dir, ".outstaff", "team.yaml"), team);
  return dir;
}

async function ost(cwd: string, args: string[], origin?: string) {
  let out = "";
  let err = "";
  const ctx: Context = {
    cwd,
    env: {},
    out: (t) => void (out += t),
    err: (t) => void (err += t),
    gitOrigin: () => origin,
  };
  const code = await run(args, ctx);
  return { code, out: out.replaceAll(root, "<tmp>"), err: err.replaceAll(root, "<tmp>") };
}

const acme = () => project(undefined, readFileSync(ACME_TEAM_FILE, "utf8"));

describe("ost --version", () => {
  it("prints the package version", async () => {
    expect(await ost(root, ["--version"])).toMatchObject({ code: 0, out: `${version}\n` });
  });
});

describe("ost validate", () => {
  // Without `humans` and with a person who has no grants, validation warns but still passes.
  const warned = () =>
    project(
      undefined,
      readFileSync(ACME_TEAM_FILE, "utf8")
        .replace(/humans:[\s\S]*?\ncatalog:/, "catalog:")
        .replace('    repos:\n      "*": read\n  - handle: kofi', "    repos: {}\n  - handle: kofi"),
    );

  it("accepts the acme team cleanly", async () => {
    const r = await ost(acme(), ["validate"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatchSnapshot();
  });

  it("lists warnings with their consequence and still exits 0", async () => {
    const r = await ost(warned(), ["validate"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Consequence:");
    expect(r.out).toMatchSnapshot();
  });

  it("prints a JSON report", async () => {
    const r = await ost(warned(), ["validate", "--json"]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out);
    expect(report).toMatchObject({ ok: true, errors: [] });
    expect(report.warnings.find((w: { code: string }) => w.code === "trust.default")).toMatchObject({ code: "trust.default", line: expect.any(Number), consequence: expect.any(String) });
    expect(r.out).toMatchSnapshot();
  });

  it.each([
    ["duplicate handle", DUPLICATE_HANDLE_TEAM],
    ["unknown repo grant", UNKNOWN_REPO_GRANT_TEAM],
    ["yaml syntax", YAML_SYNTAX_ERROR_TEAM],
    ["missing repos", MISSING_REPOS_TEAM],
  ])("exits 1 with file:line for %s", async (_name, team) => {
    const r = await ost(project(undefined, team), ["validate"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^error {4}\.outstaff\/team\.yaml:\d+:\d+ \S+: /);
    expect(r.out).toMatchSnapshot();
  });

  it("reports errors in JSON", async () => {
    const r = await ost(project(undefined, DUPLICATE_HANDLE_TEAM), ["validate", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({
      ok: false,
      errors: [{ code: "people.duplicate_handle", file: ".outstaff/team.yaml", line: expect.any(Number), column: expect.any(Number) }],
    });
  });

  it("exits 1 when no team file exists", async () => {
    const r = await ost(project(), ["validate"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("config.not_found");
  });

  it("honors --team", async () => {
    const r = await ost(project(), ["--team", join(acme(), ".outstaff", "team.yaml"), "validate"]);
    expect(r.code).toBe(0);
  });
});

describe("ost team", () => {
  it("prints the resolved acme team", async () => {
    const r = await ost(acme(), ["team"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatchSnapshot();
  });

  it("notes the default trust rule when humans is omitted", async () => {
    const team = readFileSync(ACME_TEAM_FILE, "utf8").replace(/humans:[\s\S]*?\ncatalog:/, "catalog:");
    const r = await ost(project(undefined, team), ["team"]);
    expect(r.out).toContain("Not listed; default rule");
  });

  it("prints JSON", async () => {
    const r = await ost(acme(), ["team", "--json"]);
    const json = JSON.parse(r.out);
    expect(Object.keys(json)).toEqual(["file", "team", "humans", "repos", "people", "integrations"]);
    expect(json.people).toHaveLength(8);
  });

  it("exits 1 on an invalid config", async () => {
    const r = await ost(project(undefined, MISSING_REPOS_TEAM), ["team"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(".outstaff/team.yaml:");
  });
});

describe("ost init", () => {
  it("scaffolds a valid team in an empty directory", async () => {
    const dir = join(root, "Acme Shop!");
    mkdirSync(dir);
    const r = await ost(dir, ["init"]);
    expect(r).toMatchObject({ code: 0 });
    const text = readFileSync(join(dir, ".outstaff", "team.yaml"), "utf8");
    expect(text).toContain("name: acme-shop");
    expect(text).toContain("ost hire");
    expect(text).toContain("github.com/your-org/your-repo");
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("# Outstaff secrets\n.outstaff/people/*/.env\n.env\n*.pem\n");
    expect(r.out).toMatchSnapshot();
    expect(text).toMatchSnapshot();
    expect((await ost(dir, ["validate"])).code).toBe(0);
  });

  it("detects the repo from the git origin and only adds missing ignore rules", async () => {
    const dir = project("my-app");
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n.env");
    const r = await ost(dir, ["init"], "git@github.com:acme-example/shop-app.git");
    expect(r.code).toBe(0);
    const text = readFileSync(join(dir, ".outstaff", "team.yaml"), "utf8");
    expect(text).toContain("name: shop-app\n    url: github.com/acme-example/shop-app\n    kind: primary");
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("node_modules/\n.env\n# Outstaff secrets\n.outstaff/people/*/.env\n*.pem\n");
    expect((await ost(dir, ["validate"])).code).toBe(0);
  });

  it("accepts https origins", async () => {
    const dir = project();
    await ost(dir, ["init"], "https://github.com/acme-example/shop.git");
    expect(readFileSync(join(dir, ".outstaff", "team.yaml"), "utf8")).toContain("url: github.com/acme-example/shop\n");
  });

  it("refuses to overwrite without --force", async () => {
    const dir = acme();
    const before = readFileSync(join(dir, ".outstaff", "team.yaml"), "utf8");
    const r = await ost(dir, ["init"]);
    expect(r.code).toBe(1);
    expect(r.err).toBe(".outstaff/team.yaml already exists. Use --force to overwrite it.\n");
    expect(readFileSync(join(dir, ".outstaff", "team.yaml"), "utf8")).toBe(before);
    expect((await ost(dir, ["init", "--force"])).code).toBe(0);
    expect(readFileSync(join(dir, ".outstaff", "team.yaml"), "utf8")).not.toBe(before);
  });

  it("--separate-repo writes team.yaml at the root", async () => {
    const dir = project("acme-team");
    const r = await ost(dir, ["init", "--separate-repo"], "git@github.com:acme-example/acme-team.git");
    expect(r.code).toBe(0);
    const text = readFileSync(join(dir, "team.yaml"), "utf8");
    expect(text).toContain("`kind: primary`");
    expect(text).not.toContain("acme-team.git");
    expect(text).toMatchSnapshot();
    expect((await ost(dir, ["validate"])).code).toBe(0);
  });
});

describe("cli reference", () => {
  it("matches the committed page (run `pnpm --filter outstaff run docs:cli`)", () => {
    const committed = readFileSync(new URL("../cli-reference.md", import.meta.url), "utf8");
    expect(committed).toBe(renderCliReference());
  });
});
