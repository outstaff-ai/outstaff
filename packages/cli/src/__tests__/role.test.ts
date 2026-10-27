import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { readAcmeTeam } from "@outstaff/testing.core";
import type { Context } from "../types.js";
import { run } from "../program.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "ost-role-")));
let n = 0;

const ROLES = ["pm", "product", "architect", "designer", "developer", "reviewer", "devops"];
const LINES = Array.from({ length: 12 }, (_, i) => `Line ${i + 1}.`);
const skill = (name: string) =>
  `# ${name}\n\nSkill of ${name} at {{team.name}}.\n${LINES.join("\n")}\n`;

function write(dir: string, files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
}

function stock(version = "1.0.0", files: Record<string, string> = {}) {
  const dir = join(root, `stock${n++}`);
  const base: Record<string, string> = { "package.json": JSON.stringify({ version }) };
  for (const r of ROLES) {
    base[`roles/${r}/role.yaml`] =
      `name: ${r}\ntitle: ${r === "reviewer" ? "Code Reviewer" : r}\nsummary: s\ntoolset: ${r === "reviewer" ? "code" : "base"}\npermissions: ${r === "reviewer" ? "readonly" : "docs"}\n`;

    base[`roles/${r}/SKILL.md`] = skill(r === "reviewer" ? "Code Reviewer" : r);
  }

  write(dir, { ...base, ...files });
  return dir;
}

/** The acme team with its reviewer (ines) holding `role`. */
function project(role = "reviewer") {
  const dir = join(root, `p${n++}`);
  write(dir, {
    ".outstaff/team.yaml": readAcmeTeam()
      .replace(/version: 0\.0\.0/, "version: 1.0.0")
      .replace("role: reviewer", `role: ${role}`),
  });

  return dir;
}

async function ost(cwd: string, stockCatalogDir: string, args: string[]) {
  let out = "";
  let err = "";
  const ctx: Context = {
    cwd,
    env: {},
    out: (t) => void (out += t),
    err: (t) => void (err += t),
    gitOrigin: () => undefined,
    stockCatalogDir,
  };

  const code = await run(args, ctx);
  return { code, out, err };
}

const cat = (cwd: string, rel: string) => join(cwd, ".outstaff", "catalog", rel);
const read = (cwd: string, rel: string) => readFileSync(cat(cwd, rel), "utf8");

describe("ost role new", () => {
  it("scaffolds a role from the minimal template that validates", async () => {
    const cwd = project("qa-lead");
    const s = stock();
    const r = await ost(cwd, s, ["role", "new", "qa-lead"]);
    expect(r.code).toBe(0);
    expect(read(cwd, "roles/qa-lead/role.yaml")).toContain("name: qa-lead\ntitle: Qa Lead\n");
    expect(read(cwd, "roles/qa-lead/role.yaml")).toContain("toolset: base\npermissions: docs\n");
    expect(read(cwd, "roles/qa-lead/SKILL.md")).toMatch(/^# Qa Lead\n/);
    expect(existsSync(cat(cwd, ".ejected.json"))).toBe(false);
    expect((await ost(cwd, s, ["validate"])).code).toBe(0);
    expect((await ost(cwd, s, ["build"])).code).toBe(0);
  });

  it("applies --title, --profile and --toolset", async () => {
    const cwd = project();
    const r = await ost(cwd, stock(), [
      "role",
      "new",
      "data",
      "--title",
      "Data Engineer",
      "--profile",
      "code",
      "--toolset",
      "code",
    ]);

    expect(r.code).toBe(0);
    const yaml = read(cwd, "roles/data/role.yaml");
    expect(yaml).toContain("title: Data Engineer\n");
    expect(yaml).toContain("toolset: code\npermissions: code\n");
  });

  it("copies a stock role with --from and replaces name and title", async () => {
    const cwd = project("qa");
    const s = stock();
    const r = await ost(cwd, s, ["role", "new", "qa", "--from", "reviewer", "--title", "QA"]);
    expect(r.code).toBe(0);
    expect(read(cwd, "roles/qa/role.yaml")).toBe(
      "name: qa\ntitle: QA\nsummary: s\ntoolset: code\npermissions: readonly\n",
    );

    expect(read(cwd, "roles/qa/SKILL.md")).toBe(
      skill("Code Reviewer").replace("# Code Reviewer", "# QA"),
    );

    expect(existsSync(cat(cwd, ".ejected.json"))).toBe(false);
    expect(existsSync(cat(cwd, ".base"))).toBe(false);
    expect((await ost(cwd, s, ["validate"])).code).toBe(0);
  });

  it("lets --profile and --toolset override a --from role", async () => {
    const cwd = project();
    await ost(cwd, stock(), [
      "role",
      "new",
      "qa",
      "--from",
      "reviewer",
      "--profile",
      "docs",
      "--toolset",
      "base",
    ]);

    expect(read(cwd, "roles/qa/role.yaml")).toContain("toolset: base\npermissions: docs\n");
  });

  it("refuses a stock role name and points to eject", async () => {
    const cwd = project();
    const r = await ost(cwd, stock(), ["role", "new", "developer", "--force"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("ost eject developer");
    expect(existsSync(cat(cwd, "roles/developer"))).toBe(false);
  });

  it("refuses an existing custom role unless --force", async () => {
    const cwd = project();
    const s = stock();
    await ost(cwd, s, ["role", "new", "qa"]);
    writeFileSync(cat(cwd, "roles/qa/SKILL.md"), "Mine.\n");
    const r = await ost(cwd, s, ["role", "new", "qa"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("already exists");
    expect(read(cwd, "roles/qa/SKILL.md")).toBe("Mine.\n");

    expect((await ost(cwd, s, ["role", "new", "qa", "--force"])).code).toBe(0);
    expect(read(cwd, "roles/qa/SKILL.md")).toMatch(/^# Qa\n/);
  });

  it.each(["QA", "qa_lead", "1qa", "qa-", "qa.x", "a/b", "..", "a".repeat(64)])(
    "rejects the name %s",
    async (name) => {
      const cwd = project();
      const r = await ost(cwd, stock(), ["role", "new", name]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("not a valid role name");
      expect(existsSync(cat(cwd, "roles"))).toBe(false);
    },
  );

  it("rejects an unknown --from, --profile and --toolset", async () => {
    const cwd = project();
    const s = stock();
    expect((await ost(cwd, s, ["role", "new", "qa", "--from", "nobody"])).code).toBe(1);
    expect((await ost(cwd, s, ["role", "new", "qa", "--from", "../x"])).code).toBe(1);
    expect((await ost(cwd, s, ["role", "new", "qa", "--profile", "root"])).code).toBe(1);
    expect((await ost(cwd, s, ["role", "new", "qa", "--toolset", "gpu"])).code).toBe(1);
    expect(existsSync(cat(cwd, "roles"))).toBe(false);
  });

  it("renders a person with the custom role and lists it in the context", async () => {
    const cwd = project("qa");
    const s = stock();
    await ost(cwd, s, ["role", "new", "qa", "--title", "QA"]);
    writeFileSync(
      cat(cwd, "roles/qa/SKILL.md"),
      `# QA\n\nHolders: {{#each people.byRole.qa}}{{this.handle}} {{this.role_title}};{{/each}}\nRoles: {{#each roles}}{{this.name}} {{/each}}\n`,
    );

    const out = join(cwd, "out");
    const r = await ost(cwd, s, ["render", "ines", "--out", out]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const text = readFileSync(join(out, "skills", "qa", "SKILL.md"), "utf8");
    expect(text).toContain("Holders: ines QA;");
    expect(text).toMatch(/Roles: .*developer .*qa /);
    expect((await ost(cwd, s, ["build"])).code).toBe(0);
  });

  it("is left alone by upgrade", async () => {
    const cwd = project("qa");
    await ost(cwd, stock("1.0.0"), ["eject", "developer"]);
    await ost(cwd, stock("1.0.0"), ["role", "new", "qa"]);
    const before = read(cwd, "roles/qa/SKILL.md");
    const next = stock("1.1.0", {
      "roles/qa/SKILL.md": "A stock file with the same path must not touch a custom role.\n",
    });

    const r = await ost(cwd, next, ["upgrade"]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("roles/qa");
    expect(read(cwd, "roles/qa/SKILL.md")).toBe(before);
    expect(Object.keys(JSON.parse(read(cwd, ".ejected.json")) as object)).toEqual([
      "roles/developer/role.yaml",
      "roles/developer/SKILL.md",
    ]);
  });
});
