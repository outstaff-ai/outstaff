import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { readAcmeTeam } from "../../core/src/testing/fixtures.js";
import type { Context } from "./define.js";
import { run } from "./program.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "ost-eject-")));
let n = 0;

const ROLES = ["pm", "product", "architect", "designer", "developer", "reviewer", "devops"];
const LINES = Array.from({ length: 12 }, (_, i) => `Line ${i + 1}.`);
const skill = (name: string) => `Skill of ${name} at {{team.name}}.\n${LINES.join("\n")}\n`;

function write(dir: string, files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
}

/** A stock catalog of the given version; `files` replace or add to the defaults. */
function stock(version: string, files: Record<string, string | null> = {}) {
  const dir = join(root, `stock${n++}`);
  const base: Record<string, string> = { "package.json": JSON.stringify({ version }) };
  for (const r of ROLES) {
    base[`roles/${r}/role.yaml`] =
      `name: ${r}\ntitle: ${r}\nsummary: s\ntoolset: base\npermissions: docs\n`;

    base[`roles/${r}/SKILL.md`] = skill(r);
  }

  base["references/style.md"] = "Style at {{team.name}}.\n";
  base["process/flow.md"] = "Flow.\n";
  base["toolsets/base.yaml"] = "name: base\n";
  const merged = { ...base, ...files };
  write(dir, Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== null)) as never);
  return dir;
}

function project(version = "1.0.0") {
  const dir = join(root, `p${n++}`);
  write(dir, {
    ".outstaff/team.yaml": readAcmeTeam().replace(/version: 0\.0\.0/, `version: ${version}`),
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
const index = (cwd: string) =>
  JSON.parse(read(cwd, ".ejected.json")) as Record<string, { version: string; sha256: string }>;

describe("ost eject", () => {
  it("copies a role and records its base", async () => {
    const cwd = project();
    const s = stock("1.0.0");
    const r = await ost(cwd, s, ["eject", "developer"]);
    expect(r.code).toBe(0);
    expect(read(cwd, "roles/developer/SKILL.md")).toBe(skill("developer"));
    expect(read(cwd, ".base/roles/developer/SKILL.md")).toBe(skill("developer"));
    expect(Object.keys(index(cwd))).toEqual([
      "roles/developer/role.yaml",
      "roles/developer/SKILL.md",
    ]);

    expect(index(cwd)["roles/developer/SKILL.md"]).toMatchObject({ version: "1.0.0" });
    expect(index(cwd)["roles/developer/SKILL.md"]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ejects single documents and toolsets", async () => {
    const cwd = project();
    const s = stock("1.0.0");
    for (const t of ["references/style", "process/flow.md", "toolsets/base"]) {
      expect((await ost(cwd, s, ["eject", t])).code).toBe(0);
    }

    expect(Object.keys(index(cwd))).toEqual([
      "process/flow.md",
      "references/style.md",
      "toolsets/base.yaml",
    ]);
  });

  it("ejects everything with --all", async () => {
    const cwd = project();
    const r = await ost(cwd, stock("1.0.0"), ["eject", "--all"]);
    expect(r.code).toBe(0);
    expect(Object.keys(index(cwd))).toHaveLength(ROLES.length * 2 + 3);
  });

  it("rejects an unknown target and a missing target", async () => {
    const cwd = project();
    const s = stock("1.0.0");
    expect((await ost(cwd, s, ["eject", "nobody"])).code).toBe(1);
    expect((await ost(cwd, s, ["eject"])).code).toBe(1);
    expect(existsSync(cat(cwd, ".ejected.json"))).toBe(false);
  });

  it("refuses to overwrite without --force and writes nothing", async () => {
    const cwd = project();
    const s = stock("1.0.0");
    await ost(cwd, s, ["eject", "references/style"]);
    writeFileSync(cat(cwd, "references/style.md"), "Mine.\n");

    const r = await ost(cwd, s, ["eject", "--all"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("references/style.md already exists");
    expect(read(cwd, "references/style.md")).toBe("Mine.\n");
    expect(existsSync(cat(cwd, "roles/pm/SKILL.md"))).toBe(false);

    expect((await ost(cwd, s, ["eject", "references/style", "--force"])).code).toBe(0);
    expect(read(cwd, "references/style.md")).toBe("Style at {{team.name}}.\n");
  });
});

describe("ost diff", () => {
  it("shows edits against the recorded base", async () => {
    const cwd = project();
    const s = stock("1.0.0");
    await ost(cwd, s, ["eject", "developer"]);
    expect((await ost(cwd, s, ["diff"])).out).toContain("No changes");

    writeFileSync(
      cat(cwd, "roles/developer/SKILL.md"),
      skill("developer").replace("Line 3.", "Line three."),
    );

    const r = await ost(cwd, s, ["diff", "roles/developer"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("--- a/roles/developer/SKILL.md");
    expect(r.out).toContain("+++ b/roles/developer/SKILL.md");
    expect(r.out).toContain("-Line 3.");
    expect(r.out).toContain("+Line three.");
  });

  it("rejects a path that is not ejected", async () => {
    const cwd = project();
    const s = stock("1.0.0");
    await ost(cwd, s, ["eject", "developer"]);
    expect((await ost(cwd, s, ["diff", "roles/pm"])).code).toBe(1);
  });
});

describe("ost upgrade", () => {
  const edit = (cwd: string, rel: string, from: string, to: string) =>
    writeFileSync(cat(cwd, rel), read(cwd, rel).replace(from, to));

  it("merges cleanly, updates bases and bumps the version", async () => {
    const cwd = project();
    await ost(cwd, stock("1.0.0"), ["eject", "developer", "references/style"]);
    edit(cwd, "roles/developer/SKILL.md", "Line 2.", "Line two (mine).");

    const next = stock("1.1.0", {
      "roles/developer/SKILL.md": skill("developer").replace("Line 11.", "Line eleven (stock)."),
      "references/style.md": "Style v2 at {{team.name}}.\n",
    });

    const r = await ost(cwd, next, ["upgrade"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("merged           roles/developer/SKILL.md");
    expect(r.out).toContain("updated          references/style.md");
    const merged = read(cwd, "roles/developer/SKILL.md");
    expect(merged).toContain("Line two (mine).");
    expect(merged).toContain("Line eleven (stock).");
    expect(read(cwd, "references/style.md")).toBe("Style v2 at {{team.name}}.\n");
    expect(read(cwd, ".base/roles/developer/SKILL.md")).toBe(
      readFileSync(join(next, "roles/developer/SKILL.md"), "utf8"),
    );

    expect(index(cwd)["roles/developer/SKILL.md"]?.version).toBe("1.1.0");
    expect(readFileSync(join(cwd, ".outstaff/team.yaml"), "utf8")).toMatch(/version: 1\.1\.0/);
  });

  it("writes conflict markers and fails", async () => {
    const cwd = project();
    await ost(cwd, stock("1.0.0"), ["eject", "developer"]);
    edit(cwd, "roles/developer/SKILL.md", "Line 5.", "Line five (mine).");
    const next = stock("1.1.0", {
      "roles/developer/SKILL.md": skill("developer").replace("Line 5.", "Line five (stock)."),
    });

    const r = await ost(cwd, next, ["upgrade"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("conflict         roles/developer/SKILL.md");
    expect(r.err).toContain("roles/developer/SKILL.md");
    const text = read(cwd, "roles/developer/SKILL.md");
    expect(text).toContain(
      "<<<<<<< client\nLine five (mine).\n=======\nLine five (stock).\n>>>>>>> stock",
    );

    expect(index(cwd)["roles/developer/SKILL.md"]?.version).toBe("1.1.0");

    // The conflicted file stops the image build until it is resolved.
    const b = await ost(cwd, next, ["build"]);
    expect(b.code).toBe(1);
    expect(b.err).toContain("unresolved conflict markers");
  });

  it("reports files deleted upstream and keeps them", async () => {
    const cwd = project();
    await ost(cwd, stock("1.0.0"), ["eject", "process/flow", "references/style"]);
    const next = stock("1.1.0", { "process/flow.md": null });

    const r = await ost(cwd, next, ["upgrade"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("deleted-upstream process/flow.md");
    expect(read(cwd, "process/flow.md")).toBe("Flow.\n");
    expect(index(cwd)["process/flow.md"]?.version).toBe("1.0.0");
  });

  it("leaves unchanged files alone", async () => {
    const cwd = project();
    await ost(cwd, stock("1.0.0"), ["eject", "references/style"]);
    edit(cwd, "references/style.md", "Style", "My style");
    const r = await ost(cwd, stock("1.1.0"), ["upgrade"]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("references/style.md");
    expect(read(cwd, "references/style.md")).toBe("My style at {{team.name}}.\n");
    expect(readFileSync(join(cwd, ".outstaff/team.yaml"), "utf8")).toMatch(/version: 1\.1\.0/);
  });

  it("drops a file the client deleted so it follows stock again", async () => {
    const cwd = project();
    await ost(cwd, stock("1.0.0"), ["eject", "references/style"]);
    const { rmSync } = await import("node:fs");
    rmSync(cat(cwd, "references/style.md"));
    const r = await ost(cwd, stock("1.1.0"), ["upgrade"]);
    expect(r.out).toContain("reverted");
    expect(index(cwd)).toEqual({});
  });

  it("refuses a --to that is not the installed catalog", async () => {
    const cwd = project();
    const r = await ost(cwd, stock("1.1.0"), ["upgrade", "--to", "2.0.0"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("installed catalog is 1.1.0");
    expect((await ost(cwd, stock("1.1.0"), ["upgrade", "--to", "1.1.0"])).code).toBe(0);
  });
});

describe("ost build", () => {
  it("validates and renders every person", async () => {
    const cwd = project();
    const s = stock("1.0.0");
    await ost(cwd, s, ["eject", "developer"]);
    const r = await ost(cwd, s, ["build"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/catalog 1\.0\.0, 2 ejected files, \d+ people rendered/);
  });

  it("fails on an ejected file with an unknown placeholder", async () => {
    const cwd = project();
    const s = stock("1.0.0");
    await ost(cwd, s, ["eject", "references/style"]);
    writeFileSync(cat(cwd, "references/style.md"), "Hello {{team.nope}}.\n");
    const r = await ost(cwd, s, ["build"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Build failed");
  });

  it("fails on an invalid team", async () => {
    const cwd = project("not-a-version");
    const r = await ost(cwd, stock("1.0.0"), ["build"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("catalog.invalid_version");
  });
});

describe("a tampered .ejected.json", () => {
  const record = { version: "1.0.0", sha256: "0".repeat(64) };
  const tamper = async (entry: string) => {
    const cwd = project();
    const s = stock("1.0.0");
    await ost(cwd, s, ["eject", "references/style"]);
    const idx = index(cwd);
    idx[entry] = record;
    writeFileSync(cat(cwd, ".ejected.json"), JSON.stringify(idx));
    return { cwd, s };
  };

  it.each([
    "../../escape.md",
    "/etc/passwd",
    "references/../../x.md",
    "elsewhere/x.md",
    "references\\x.md",
  ])("rejects %s in upgrade, diff and build", async (entry) => {
    const { cwd, s } = await tamper(entry);
    for (const args of [["upgrade"], ["diff"], ["build"], ["eject", "developer"]]) {
      const r = await ost(cwd, s, args);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`invalid entry "${entry}"`);
    }
  });

  it("rejects a traversal path argument to diff", async () => {
    const cwd = project();
    const s = stock("1.0.0");
    await ost(cwd, s, ["eject", "references/style"]);
    expect((await ost(cwd, s, ["diff", "../../x"])).code).toBe(1);
  });
});
