import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ACME_TEAM_FILE,
  DUPLICATE_HANDLE_TEAM,
  MISSING_REPOS_TEAM,
  readAcmeTeam,
  UNKNOWN_REPO_GRANT_TEAM,
  YAML_SYNTAX_ERROR_TEAM,
} from "@outstaff/testing.core";
import { formatIssue, loadTeamConfig } from "../load.js";
import type { LoadResult } from "../types.js";

const root = mkdtempSync(join(tmpdir(), "outstaff-load-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
const tmp = (): string => {
  const d = join(root, `t${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};

const put = (dir: string, rel: string, text: string): string => {
  const f = join(dir, rel);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, text);
  return f;
};

const marked = (name: string) => readAcmeTeam().replace("name: acme", `name: ${name}`);
const teamName = (r: LoadResult) => {
  if (!r.ok) {
    throw new Error(JSON.stringify(r.issues));
  }

  return r.config.team.name;
};

const issues = (r: LoadResult) => {
  if (r.ok) {
    throw new Error("expected failure");
  }

  return r.issues;
};

const env = {};

describe("acme example", () => {
  it("loads cleanly", async () => {
    const r = await loadTeamConfig({ team: ACME_TEAM_FILE, env });
    if (!r.ok) {
      throw new Error("expected the acme team to load");
    }

    expect(r.config.people).toHaveLength(8);
    expect(r.source.kind).toBe("file");
    expect(r.source.dir).toBe(join(ACME_TEAM_FILE, ".."));
  });
});

describe("discovery", () => {
  it("prefers ./.outstaff/team.yaml over ./team.yaml", async () => {
    const cwd = tmp();
    put(cwd, ".outstaff/team.yaml", marked("nested"));
    put(cwd, "team.yaml", marked("flat"));
    expect(teamName(await loadTeamConfig({ cwd, env }))).toBe("nested");
  });

  it("falls back to ./team.yaml", async () => {
    const cwd = tmp();
    put(cwd, "team.yaml", marked("flat"));
    expect(teamName(await loadTeamConfig({ cwd, env }))).toBe("flat");
  });

  it("walks up from a subdirectory to the repository root", async () => {
    const repo = tmp();
    mkdirSync(join(repo, ".git"));
    put(repo, ".outstaff/team.yaml", marked("root"));
    const cwd = join(repo, "packages", "app");
    mkdirSync(cwd, { recursive: true });
    const result = await loadTeamConfig({ cwd, env });
    expect(teamName(result)).toBe("root");
    expect(result.ok && result.source.dir).toBe(join(repo, ".outstaff"));
  });

  it("takes the nearest team file and stops at the repository root", async () => {
    const outer = tmp();
    put(outer, ".outstaff/team.yaml", marked("outer"));
    const repo = join(outer, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const cwd = join(repo, "sub");
    mkdirSync(cwd);
    const [issue] = issues(await loadTeamConfig({ cwd, env }));
    expect(issue?.code).toBe("config.not_found");
    put(repo, "sub/team.yaml", marked("near"));
    expect(teamName(await loadTeamConfig({ cwd, env }))).toBe("near");
  });

  it("reports config.not_found with the places tried", async () => {
    const cwd = tmp();
    const [issue] = issues(await loadTeamConfig({ cwd, env }));
    expect(issue?.code).toBe("config.not_found");
    expect(issue?.message).toContain(join(".outstaff", "team.yaml"));
    expect(issue?.message).toContain("team.yaml");
  });

  it("accepts a file or a directory as the team option", async () => {
    const cwd = tmp();
    const other = tmp();
    const f = put(other, "custom.yaml", marked("custom"));
    expect(teamName(await loadTeamConfig({ cwd, team: f, env }))).toBe("custom");
    put(other, ".outstaff/team.yaml", marked("indir"));
    expect(teamName(await loadTeamConfig({ cwd, team: other, env }))).toBe("indir");
  });

  it("the team option beats the environment", async () => {
    const cwd = tmp();
    const a = put(cwd, "a.yaml", marked("option"));
    const b = put(cwd, "b.yaml", marked("envfile"));
    expect(teamName(await loadTeamConfig({ cwd, team: a, env: { OUTSTAFF_TEAM_FILE: b } }))).toBe(
      "option",
    );
  });
});

describe("environment sources", () => {
  const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
  const makeRepo = () => {
    const work = tmp();
    sh(work, "init", "-q", "-b", "main");
    sh(work, "config", "user.email", "t@example.test");
    sh(work, "config", "user.name", "t");
    put(work, ".outstaff/team.yaml", marked("main-team"));
    sh(work, "add", "-A");
    sh(work, "commit", "-qm", "one");
    sh(work, "checkout", "-q", "-b", "release");
    put(work, ".outstaff/team.yaml", marked("release-team"));
    sh(work, "commit", "-qam", "two");
    sh(work, "checkout", "-q", "main");
    const bare = join(tmp(), "team.git");
    sh(work, "clone", "-q", "--bare", work, bare);
    return `file://${bare}`;
  };

  const url = makeRepo();

  it("OUTSTAFF_TEAM_FILE beats OUTSTAFF_TEAM_REPO and discovery", async () => {
    const cwd = tmp();
    put(cwd, "team.yaml", marked("flat"));
    const f = put(cwd, "mounted.yaml", marked("mounted"));
    const r = await loadTeamConfig({
      cwd,
      env: { OUTSTAFF_TEAM_FILE: f, OUTSTAFF_TEAM_REPO: "file:///nonexistent" },
    });

    expect(teamName(r)).toBe("mounted");
  });

  it("clones a git URL into the cache, default branch", async () => {
    const cacheDir = tmp();
    const r = await loadTeamConfig({ cwd: tmp(), team: url, cacheDir, env });
    expect(teamName(r)).toBe("main-team");
    if (!r.ok) {
      throw new Error("expected the git team to load");
    }

    expect(r.source).toMatchObject({ kind: "git", repo: url });
    expect(r.source.file.startsWith(cacheDir)).toBe(true);
  });

  it("checks out #ref and refreshes an existing cache", async () => {
    const cacheDir = tmp();
    expect(
      teamName(await loadTeamConfig({ cwd: tmp(), team: `${url}#release`, cacheDir, env })),
    ).toBe("release-team");

    expect(
      teamName(await loadTeamConfig({ cwd: tmp(), team: `${url}#release`, cacheDir, env })),
    ).toBe("release-team");
  });

  it("OUTSTAFF_TEAM_REPO + OUTSTAFF_TEAM_REF beat discovery", async () => {
    const cwd = tmp();
    put(cwd, "team.yaml", marked("flat"));
    const r = await loadTeamConfig({
      cwd,
      cacheDir: tmp(),
      env: { OUTSTAFF_TEAM_REPO: url, OUTSTAFF_TEAM_REF: "release" },
    });

    expect(teamName(r)).toBe("release-team");
    if (!r.ok) {
      throw new Error("expected the git team to load");
    }

    expect(r.source.ref).toBe("release");
  });

  it("reports config.git_failed for an unreachable repo", async () => {
    const r = await loadTeamConfig({
      cwd: tmp(),
      team: "file:///nonexistent/repo.git",
      cacheDir: tmp(),
      env,
    });

    expect(issues(r)[0]?.code).toBe("config.git_failed");
  });
});

describe("issue positions", () => {
  const load = async (text: string) => {
    const cwd = tmp();
    put(cwd, ".outstaff/team.yaml", text);
    return issues(await loadTeamConfig({ cwd, env }));
  };

  const lineOf = (text: string, needle: string, nth = 0) => {
    const lines = text.split("\n");
    let seen = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.includes(needle) && ++seen === nth) {
        return i + 1;
      }
    }

    throw new Error(needle);
  };

  const acme = readAcmeTeam();

  it("duplicate handle points at the value", async () => {
    const [i] = await load(DUPLICATE_HANDLE_TEAM);
    expect(i).toMatchObject({
      code: "people.duplicate_handle",
      file: join(".outstaff", "team.yaml"),
      line: lineOf(DUPLICATE_HANDLE_TEAM, "handle: sam", 1),
      column: 13,
    });

    expect(formatIssue(i!)).toMatch(/^\.outstaff\/team\.yaml:\d+:13 people\.duplicate_handle: /);
  });

  it("unknown repo grant points at the nested key people.4.repos.billing", async () => {
    const [i] = await load(UNKNOWN_REPO_GRANT_TEAM);
    expect(i).toMatchObject({
      code: "people.unknown_repo",
      path: ["people", 4, "repos", "billing"],
      line: lineOf(UNKNOWN_REPO_GRANT_TEAM, "billing"),
      column: 7,
    });
  });

  it("missing required key falls back to the document root", async () => {
    const [i] = await load(MISSING_REPOS_TEAM);
    expect(i).toMatchObject({
      path: ["repos"],
      line: lineOf(MISSING_REPOS_TEAM, "version:"),
      column: 1,
    });
  });

  it("missing nested key falls back to the nearest existing parent key", async () => {
    const text = acme.replace("    adapter: itsaplan\n    url", "    url");
    const [i] = await load(text);
    expect(i).toMatchObject({
      path: ["integrations", "tracker", "adapter"],
      line: text.split("\n").indexOf("  tracker:") + 1,
      column: 3,
    });
  });

  it("unknown key points at the key", async () => {
    const text = acme.replace("  product: Acme Shop", "  product: Acme Shop\n  colour: red");
    const [i] = await load(text);
    expect(i).toMatchObject({
      code: "schema.unknown_key",
      line: lineOf(text, "colour"),
      column: 3,
    });
  });

  it("invalid enum value points at the value", async () => {
    const text = acme.replace("preset: kanban", "preset: waterfall");
    const [i] = await load(text);
    expect(i).toMatchObject({
      code: "schema.invalid_value",
      line: lineOf(text, "preset:"),
      column: 11,
    });
  });

  it("wrong type in a sequence item points at the item", async () => {
    const text = acme.replace("extends: [developer]", "extends: [developer, 7]");
    const [i] = await load(text);
    expect(i).toMatchObject({
      code: "schema.invalid_type",
      line: lineOf(text, "extends:"),
      column: 26,
    });
  });

  it("yaml syntax errors carry their position", async () => {
    const r = await load(YAML_SYNTAX_ERROR_TEAM);
    expect(r[0]).toMatchObject({
      code: "config.yaml_syntax",
      file: join(".outstaff", "team.yaml"),
    });

    expect(r[0]!.line).toBeGreaterThan(1);
  });
});
