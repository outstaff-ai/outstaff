import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger, type RepoRef, type Vcs } from "@outstaff/core";
import { createFakeVcs } from "@outstaff/core/fakes";
import { describe, expect, it, vi } from "vitest";
import type { Offer } from "#/office-client/index.js";
import { acmeTeam } from "@outstaff/testing.agent";
import { cappedAccess, fileOnlySecrets } from "#/repos/access.js";
import { syncRepositories } from "#/repos/clone.js";
import { runGit } from "#/repos/git.js";
import type { RunGit, SyncRepositoriesOptions } from "#/repos/types.js";
import {
  createCredentialHelper,
  parseCredentialRequest,
  repoForRequest,
} from "#/repos/credential-helper.js";
import { createWorkspaces, findConventionFiles, headBranchOf } from "#/repos/workspaces.js";
import { repoForItem } from "#/repos/item-repo.js";

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const host = "github.com";
const ref = (name: string): Required<RepoRef> => ({ host, owner: "acme-example", name });

/** A local bare repository per team repo, each with one commit on main, standing in for the host. */
function remotes(names: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "ost-repos-"));
  const bare = (name: string) => join(dir, "remote", `${name}.git`);
  for (const name of names) {
    const seed = join(dir, "seed", name);
    mkdirSync(seed, { recursive: true });
    sh(seed, "init", "-q", "-b", "main");
    sh(seed, "config", "user.name", "Seed");
    sh(seed, "config", "user.email", "seed@acme.example");
    writeFileSync(join(seed, "README.md"), `# ${name}\n`);
    sh(seed, "add", ".");
    sh(seed, "commit", "-q", "-m", "init");
    sh(dir, "clone", "-q", "--bare", seed, bare(name));
  }

  return { dir, bare, remoteUrl: (r: Required<RepoRef>) => bare(r.name) };
}

/** Pushes a new commit with one file to a remote's main, as if a pull request merged. */
function pushSeed(r: { dir: string; bare: (name: string) => string }, name: string, file: string) {
  const seed = join(r.dir, "seed", name);
  writeFileSync(join(seed, file), `${file}\n`);
  sh(seed, "add", ".");
  sh(seed, "commit", "-q", "-m", file);
  sh(seed, "push", "-q", r.bare(name), "main");

  return sh(seed, "rev-parse", "HEAD").trim();
}

/** A fake VCS where sam may write shop and read design-system, and nothing else. */
function samVcs() {
  const vcs = createFakeVcs({ host });
  const credentials = vi.spyOn(vcs, "credentials");
  return { vcs, credentials, ready: seedSam(vcs) };
}

async function seedSam(vcs: ReturnType<typeof createFakeVcs>) {
  await vcs.seed.permission(ref("shop"), "sam", "write");
  await vcs.seed.permission(ref("design-system"), "sam", "read");
}

const offer = (id: string, extra: Partial<Offer["context"]> = {}, kind = "ticket"): Offer =>
  ({
    workItem: { id, kind, title: `Fix ${id} now`, priority: 1, trigger: "human" },
    context: { journal: [], subjects: [], links: [], ...extra },
  }) as Offer;

describe("credential helper", () => {
  const request = (path: string, protocol = "https", h = host) =>
    `protocol=${protocol}\nhost=${h}\npath=${path}\n\n`;

  it("parses git's key=value request and stops at the blank line", () => {
    expect(parseCredentialRequest("protocol=https\nhost=github.com\n\nignored=1\n")).toEqual({
      protocol: "https",
      host: "github.com",
    });
  });

  it("matches the team repo by host and path, only over https", () => {
    const team = acmeTeam();
    const find = (r: Record<string, string>) => repoForRequest(team, r)?.name;
    expect(find({ protocol: "https", host, path: "acme-example/shop.git" })).toBe("shop");
    expect(find({ protocol: "https", host: "GitHub.com", path: "Acme-Example/Shop" })).toBe("shop");
    expect(find({ protocol: "http", host, path: "acme-example/shop" })).toBeUndefined();
    expect(find({ protocol: "https", host, path: "acme-example/other" })).toBeUndefined();
    expect(find({ protocol: "https", host })).toBeUndefined();
  });

  it("asks the VCS for a token scoped to the repo at the access the grant gives", async () => {
    const { vcs, credentials, ready } = samVcs();
    await ready;
    const helper = createCredentialHelper({
      team: acmeTeam(),
      person: "sam",
      vcs,
      profile: "code",
    });

    const write = await helper.run("get", request("acme-example/shop.git"));
    expect(write).toContain("username=x-access-token\npassword=fake-token-sam-write\n");
    expect(write).toMatch(/password_expiry_utc=\d+\n$/);
    expect(credentials).toHaveBeenLastCalledWith("sam", ref("shop"), "write");

    const read = await helper.run("get", request("acme-example/design-system.git"));
    expect(read).toContain("password=fake-token-sam-read\n");
    expect(credentials).toHaveBeenLastCalledWith("sam", ref("design-system"), "read");
  });

  it("answers nothing for repos without a grant or outside the team, and never stores", async () => {
    const { vcs, credentials, ready } = samVcs();
    await ready;
    const helper = createCredentialHelper({
      team: acmeTeam(),
      person: "sam",
      vcs,
      profile: "code",
    });

    expect(await helper.run("get", request("acme-example/infra.git"))).toBe("");
    expect(await helper.run("get", request("someone/else.git"))).toBe("");
    expect(await helper.run("store", `${request("acme-example/shop")}password=x\n`)).toBe("");
    expect(await helper.run("erase", request("acme-example/shop"))).toBe("");
    expect(credentials).not.toHaveBeenCalled();
  });

  it("never issues a write token to the readonly profile; the others follow the grant", async () => {
    const { vcs, credentials, ready } = samVcs();
    await ready;
    const get = async (profile: "readonly" | "docs" | "code" | "infra") =>
      createCredentialHelper({ team: acmeTeam(), person: "sam", vcs, profile }).run(
        "get",
        request("acme-example/shop.git"),
      );

    expect(await get("readonly")).toContain("password=fake-token-sam-read\n");
    expect(credentials).toHaveBeenLastCalledWith("sam", ref("shop"), "read");
    for (const profile of ["docs", "code", "infra"] as const) {
      expect(await get(profile)).toContain("password=fake-token-sam-write\n");
      expect(credentials).toHaveBeenLastCalledWith("sam", ref("shop"), "write");
    }

    expect(cappedAccess("write", "docs")).toBe("write");
    expect(cappedAccess("read", "code")).toBe("read");
  });

  it("reads secrets from files only", () => {
    const dir = mkdtempSync(join(tmpdir(), "ost-secrets-"));
    writeFileSync(join(dir, "APP_KEY"), "from-file\n");
    const secrets = fileOnlySecrets({ OUTSTAFF_SECRETS_DIR: dir, OTHER: "from-env" });
    expect(secrets.require("APP_KEY")).toBe("from-file");
    expect(secrets.get("OTHER")).toBeUndefined();
    expect(() => secrets.require("OTHER")).toThrow(
      `secrets must be provided as files under ${dir}; env-only secrets are not visible to git's credential helper`,
    );
  });

  it("still tells the credential helper who the container acts as", () => {
    const secrets = fileOnlySecrets({
      OUTSTAFF_SECRETS_DIR: "/nonexistent",
      OUTSTAFF_PERSON: "sam",
    });

    expect(secrets.require("OUTSTAFF_PERSON")).toBe("sam");
    expect(
      fileOnlySecrets({ OUTSTAFF_SECRETS_DIR: "/nonexistent" }).get("OUTSTAFF_PERSON"),
    ).toBeUndefined();
  });

  it("lets a refusal from the VCS through", async () => {
    const vcs: Vcs = createFakeVcs({ host });
    const helper = createCredentialHelper({
      team: acmeTeam(),
      person: "sam",
      vcs,
      profile: "code",
    });

    await expect(helper.run("get", request("acme-example/shop.git"))).rejects.toThrow(
      "no write access",
    );
  });
});

describe("syncRepositories", () => {
  async function setup() {
    const r = remotes(["shop", "infra", "design-system", "docs-site"]);
    const { vcs, credentials, ready } = samVcs();
    await ready;
    const reposDir = join(r.dir, "home", "repos");
    const sync = (o: Partial<SyncRepositoriesOptions> = {}) =>
      syncRepositories({
        team: acmeTeam(),
        person: "sam",
        vcs,
        profile: "code",
        reposDir,
        remoteUrl: r.remoteUrl,
        log: silentLogger,
        ...o,
      });

    const run = async () => (await sync()).ready;
    return { ...r, vcs, credentials, reposDir, sync, run };
  }

  it("clones the repos the person has a grant on and nothing else", async () => {
    const s = await setup();
    const repos = await s.run();

    expect(repos.map((x) => `${x.name}:${x.access}`).toSorted()).toEqual([
      "design-system:read",
      "shop:write",
    ]);

    expect(existsSync(join(s.reposDir, "shop/README.md"))).toBe(true);
    expect(existsSync(join(s.reposDir, "design-system/README.md"))).toBe(true);
    expect(existsSync(join(s.reposDir, "infra"))).toBe(false);
    expect(existsSync(join(s.reposDir, "docs-site"))).toBe(false);
    expect(s.credentials.mock.calls.map((c) => `${c[1].name}:${c[2]}`).toSorted()).toEqual([
      "design-system:read",
      "shop:write",
    ]);
  });

  it("treats a write grant as read for the readonly profile, hook included", async () => {
    const s = await setup();
    const { ready: repos } = await syncRepositories({
      team: acmeTeam(),
      person: "sam",
      vcs: s.vcs,
      profile: "readonly",
      reposDir: join(s.dir, "docs-home/repos"),
      remoteUrl: s.remoteUrl,
    });

    expect(repos.map((r) => `${r.name}:${r.access}`).toSorted()).toEqual([
      "design-system:read",
      "shop:read",
    ]);

    expect(s.credentials).toHaveBeenCalledWith("sam", ref("shop"), "read");
    const hook = readFileSync(join(s.dir, "docs-home/repos/shop/.git/hooks/pre-push"), "utf8");
    expect(hook).toContain("read-only");
  });

  it("configures the helper, the author and the hook per clone, with no token on disk", async () => {
    const s = await setup();
    await s.run();
    const shop = join(s.reposDir, "shop");

    expect(sh(shop, "config", "--local", "--get-all", "credential.helper")).toBe(
      "\n!ost git-credential\n",
    );

    expect(sh(shop, "config", "--local", "credential.useHttpPath").trim()).toBe("true");
    expect(sh(shop, "config", "user.name").trim()).toBe("sam");
    expect(sh(shop, "config", "user.email").trim()).toBe("sam@acme.example");
    expect(statSync(join(shop, ".git/hooks/pre-push")).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(shop, ".git/config"), "utf8")).not.toContain("fake-token");
    expect(readFileSync(join(shop, ".git/hooks/pre-push"), "utf8")).not.toContain("fake-token");
  });

  it("prepares an existing clone again on a restart, with the helper list unchanged", async () => {
    const s = await setup();
    await s.run();
    const second = await s.run();
    const shop = join(s.reposDir, "shop");

    expect(second.map((r) => r.name)).toContain("shop");
    expect(sh(shop, "config", "--local", "--get-all", "credential.helper")).toBe(
      "\n!ost git-credential\n",
    );
  });

  it("fetches an existing clone instead of cloning again", async () => {
    const s = await setup();
    await s.run();

    const seed = join(s.dir, "seed/shop");
    writeFileSync(join(seed, "NEW.md"), "new\n");
    sh(seed, "add", ".");
    sh(seed, "commit", "-q", "-m", "more");
    sh(seed, "push", "-q", s.bare("shop"), "main");

    await s.run();
    const shop = join(s.reposDir, "shop");
    expect(sh(shop, "rev-parse", "origin/main")).toBe(sh(seed, "rev-parse", "HEAD"));
    // The base clone itself moves too, so whatever reads it sees the new commit.
    expect(sh(shop, "rev-parse", "HEAD")).toBe(sh(seed, "rev-parse", "HEAD"));
    expect(existsSync(join(shop, "NEW.md"))).toBe(true);
    expect(sh(shop, "config", "--local", "--get-all", "credential.helper")).toBe(
      "\n!ost git-credential\n",
    );

    expect(statSync(join(shop, ".git/hooks/pre-push")).mode & 0o111).not.toBe(0);
  });

  it("follows a repository that moved: the existing clone's origin is reset and the fetch succeeds", async () => {
    const s = await setup();
    await s.run();
    const shop = join(s.reposDir, "shop");
    const before = sh(shop, "rev-parse", "origin/main").trim();

    // The repository moves to another owner; the old address is gone.
    const moved = join(s.dir, "remote/acme-moved/shop.git");
    mkdirSync(join(s.dir, "remote/acme-moved"), { recursive: true });
    renameSync(s.bare("shop"), moved);
    const seed = join(s.dir, "seed/shop");
    writeFileSync(join(seed, "MOVED.md"), "moved\n");
    sh(seed, "add", ".");
    sh(seed, "commit", "-q", "-m", "after the move");
    sh(seed, "push", "-q", moved, "main");

    const info = vi.fn<(message: string, data?: Record<string, unknown>) => void>();
    const remoteUrl = (r: Required<RepoRef>) => (r.name === "shop" ? moved : s.bare(r.name));
    const repos = await s.sync({ remoteUrl, log: { ...silentLogger, info } });

    expect(repos.unprepared()).toEqual([]);
    expect(repos.ready.map((r) => r.name)).toContain("shop");
    expect(sh(shop, "remote", "get-url", "origin").trim()).toBe(moved);
    expect(sh(shop, "rev-parse", "origin/main").trim()).toBe(sh(seed, "rev-parse", "HEAD").trim());
    expect(sh(shop, "cat-file", "-t", before).trim()).toBe("commit");
    expect(existsSync(join(shop, "MOVED.md"))).toBe(true);
    expect(info).toHaveBeenCalledWith("the repository's URL changed, so its clone follows it", {
      repo: "shop",
      from: s.bare("shop"),
      to: moved,
    });

    // Once it follows, a restart leaves the remote alone; a clone with no origin at all gets one.
    info.mockClear();
    sh(join(s.reposDir, "design-system"), "remote", "remove", "origin");
    await s.sync({ remoteUrl, log: { ...silentLogger, info } });
    expect(info.mock.calls.map((c) => c[1]?.["repo"])).toEqual(["design-system"]);
    expect(sh(join(s.reposDir, "design-system"), "remote", "get-url", "origin").trim()).toBe(
      s.bare("design-system"),
    );
  });

  it("keeps a repository that failed with its error, and prepares it on a retry once fixed", async () => {
    const s = await setup();
    const missing = join(s.dir, "remote/acme-new/shop.git");
    const repos = await s.sync({
      remoteUrl: (r) => (r.name === "shop" ? missing : s.bare(r.name)),
    });

    expect(repos.ready.map((r) => r.name)).toEqual(["design-system"]);
    expect(repos.unprepared()).toEqual([
      {
        name: "shop",
        dir: join(s.reposDir, "shop"),
        ref: ref("shop"),
        access: "write",
        kind: "primary",
        error: expect.stringContaining("git clone failed") as string,
      },
    ]);

    await expect(repos.retry("shop")).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringMatching(/^shop could not be prepared: git clone failed/) as string,
    });

    expect(repos.unprepared().map((u) => u.name)).toEqual(["shop"]);

    mkdirSync(join(s.dir, "remote/acme-new"), { recursive: true });
    renameSync(s.bare("shop"), missing);
    const shop = await repos.retry("shop");
    expect(shop).toMatchObject({ name: "shop", access: "write" });
    expect(repos.ready.map((r) => r.name)).toEqual(["design-system", "shop"]);
    expect(repos.unprepared()).toEqual([]);
    expect(await repos.retry("shop")).toBe(shop);
    await expect(repos.retry("infra")).rejects.toMatchObject({ code: "not_found" });
  });

  it("prepares nothing for someone who is not on the team", async () => {
    const s = await setup();
    const repos = await s.sync({ person: "nobody" });
    expect(repos.ready).toEqual([]);
    expect(repos.unprepared()).toEqual([]);
  });

  it("leaves a base clone with local changes where it is and reports it", async () => {
    const s = await setup();
    await s.run();
    const shop = join(s.reposDir, "shop");
    const before = sh(shop, "rev-parse", "HEAD");
    writeFileSync(join(shop, "README.md"), "# changed by hand\n");
    pushSeed(s, "shop", "NEW.md");

    const warn = vi.fn<(message: string, data?: Record<string, unknown>) => void>();
    const { ready: repos } = await syncRepositories({
      team: acmeTeam(),
      person: "sam",
      vcs: s.vcs,
      profile: "code",
      reposDir: s.reposDir,
      remoteUrl: s.remoteUrl,
      log: { ...silentLogger, warn },
    });

    expect(repos.map((r) => r.name)).toContain("shop");
    expect(sh(shop, "rev-parse", "HEAD")).toBe(before);
    expect(readFileSync(join(shop, "README.md"), "utf8")).toBe("# changed by hand\n");
    expect(warn).toHaveBeenCalledWith(
      "a base clone has local changes, so it was not moved to the default branch",
      expect.objectContaining({ repo: "shop", changed: 1 }),
    );
  });

  it("skips a repo it cannot reach and keeps the others", async () => {
    const s = await setup();
    const warn = vi.fn<(message: string, data?: Record<string, unknown>) => void>();
    const { ready: repos } = await syncRepositories({
      team: acmeTeam(),
      person: "sam",
      vcs: s.vcs,
      profile: "code",
      reposDir: s.reposDir,
      remoteUrl: (r) => (r.name === "shop" ? join(s.dir, "missing.git") : s.bare(r.name)),
      log: { ...silentLogger, warn },
    });

    expect(repos.map((r) => r.name)).toEqual(["design-system"]);
    expect(warn).toHaveBeenCalledWith(
      "could not prepare a repository",
      expect.objectContaining({ repo: "shop" }),
    );
  });
});

describe("push safety", () => {
  async function cloned() {
    const r = remotes(["shop", "design-system"]);
    const { vcs, ready } = samVcs();
    await ready;
    const reposDir = join(r.dir, "home", "repos");
    const { ready: repos } = await syncRepositories({
      team: acmeTeam(),
      person: "sam",
      vcs,
      profile: "code",
      reposDir,
      remoteUrl: r.remoteUrl,
    });

    return { ...r, repos };
  }

  const push = (cwd: string, spec: string) => {
    try {
      sh(cwd, "push", "origin", spec);
      return { ok: true, error: "" };
    } catch (e) {
      return { ok: false, error: String((e as { stderr?: string }).stderr) };
    }
  };

  it("refuses a push to the default branch but allows another branch", async () => {
    const s = await cloned();
    const shop = join(s.dir, "home/repos/shop");
    // The base clone is detached at the default branch; a push comes from a branch.
    sh(shop, "switch", "-q", "-c", "local/a");
    writeFileSync(join(shop, "a.txt"), "a\n");
    sh(shop, "add", ".");
    sh(shop, "commit", "-q", "-m", "a");

    const denied = push(shop, "HEAD:main");
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain("default branch");
    expect(denied.error).toContain("is refused");
    expect(push(shop, "HEAD:refs/heads/main").ok).toBe(false);
    expect(push(shop, "HEAD:feature/a").ok).toBe(true);
    expect(sh(s.bare("shop"), "rev-parse", "--verify", "feature/a")).toMatch(/^[0-9a-f]{40}/);
  });

  it("refuses every push from a repo with read access", async () => {
    const s = await cloned();
    const ds = join(s.dir, "home/repos/design-system");
    sh(ds, "switch", "-q", "-c", "local/a");
    writeFileSync(join(ds, "a.txt"), "a\n");
    sh(ds, "add", ".");
    sh(ds, "-c", "user.name=x", "-c", "user.email=x@x", "commit", "-q", "-m", "a");

    const denied = push(ds, "HEAD:feature/a");
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain("read-only");
    expect(() => sh(s.bare("design-system"), "rev-parse", "--verify", "feature/a")).toThrow(/./);
  });
});

describe("workspaces", () => {
  async function setup() {
    const r = remotes(["shop", "design-system"]);
    const { vcs, ready } = samVcs();
    await ready;
    const home = join(r.dir, "home");
    const layout = { worktreesDir: join(home, "worktrees"), scratchDir: join(home, "scratch") };
    const { ready: repos } = await syncRepositories({
      team: acmeTeam(),
      person: "sam",
      vcs,
      profile: "code",
      reposDir: join(home, "repos"),
      remoteUrl: r.remoteUrl,
    });

    return { ...r, layout, repos, workspaces: createWorkspaces({ layout, repos }) };
  }

  it("picks the repo a subject points at, else the primary one", async () => {
    const s = await setup();
    const url = "https://github.com/acme-example/design-system/pull/3";
    expect(
      repoForItem(offer("a", { subjects: [{ type: "pr", ref: "3", url }] }), s.repos)?.name,
    ).toBe("design-system");

    expect(repoForItem(offer("b"), s.repos)?.name).toBe("shop");
  });

  it("creates a worktree and scratch on the first round, reuses them later and removes them when done", async () => {
    const s = await setup();
    const w1 = await s.workspaces.prepare(offer("w1"));
    expect(w1).toMatchObject({
      repo: "shop",
      branch: undefined,
      worktree: join(s.layout.worktreesDir, "shop/w1"),
      scratch: join(s.layout.scratchDir, "w1"),
    });

    expect(readFileSync(join(w1!.worktree, "README.md"), "utf8")).toContain("shop");
    // New work starts detached at the default branch; no branch is created or named.
    expect(sh(w1!.worktree, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("HEAD");
    expect(sh(w1!.worktree, "rev-parse", "HEAD").trim()).toBe(
      sh(w1!.worktree, "rev-parse", "origin/main").trim(),
    );

    expect(sh(join(s.dir, "home/repos/shop"), "branch", "--list").trim()).not.toContain("w1");
    expect(existsSync(w1!.scratch)).toBe(true);

    // Round two: the work of round one is still there.
    writeFileSync(join(w1!.worktree, "wip.txt"), "unfinished\n");
    const again = await s.workspaces.prepare(offer("w1"));
    expect(again).toEqual(w1);
    expect(readFileSync(join(w1!.worktree, "wip.txt"), "utf8")).toBe("unfinished\n");

    await s.workspaces.release("w1");
    expect(existsSync(w1!.worktree)).toBe(false);
    expect(existsSync(w1!.scratch)).toBe(false);
  });

  it("starts from the up-to-date default branch", async () => {
    const s = await setup();
    const seed = join(s.dir, "seed/shop");
    writeFileSync(join(seed, "LATER.md"), "later\n");
    sh(seed, "add", ".");
    sh(seed, "commit", "-q", "-m", "later");
    sh(seed, "push", "-q", s.bare("shop"), "main");

    const w = await s.workspaces.prepare(offer("w2"));
    expect(existsSync(join(w!.worktree, "LATER.md"))).toBe(true);
  });

  it("moves the base clone to the fetched default branch before a round", async () => {
    const s = await setup();
    const merged = pushSeed(s, "shop", "MERGED.md");

    await s.workspaces.prepare(offer("w3"));
    const shop = join(s.dir, "home/repos/shop");
    expect(sh(shop, "rev-parse", "HEAD").trim()).toBe(merged);
    expect(existsSync(join(shop, "MERGED.md"))).toBe(true);
  });

  it("refreshes every base clone for a chat session, fetching each at most once a minute", async () => {
    const s = await setup();
    let now = 1_000_000;
    const workspaces = createWorkspaces({ layout: s.layout, repos: s.repos, now: () => now });
    const shop = join(s.dir, "home/repos/shop");

    const first = pushSeed(s, "shop", "ONE.md");
    const heads = await workspaces.refresh();
    expect(heads).toEqual([
      { name: "shop", commit: first, atDefault: true },
      {
        name: "design-system",
        commit: sh(join(s.dir, "seed/design-system"), "rev-parse", "HEAD").trim(),
        atDefault: true,
      },
    ]);

    expect(existsSync(join(shop, "ONE.md"))).toBe(true);

    const second = pushSeed(s, "shop", "TWO.md");
    now += 30_000;
    expect((await workspaces.refresh())[0]!.commit).toBe(first.trim());

    now += 30_000;
    expect((await workspaces.refresh())[0]!.commit).toBe(second.trim());
    expect(existsSync(join(shop, "TWO.md"))).toBe(true);
  });

  it("reports a clone it cannot fetch at the commit it is at", async () => {
    const s = await setup();
    const shop = join(s.dir, "home/repos/shop");
    sh(shop, "remote", "set-url", "origin", join(s.dir, "missing.git"));
    const warn = vi.fn<(message: string, data?: Record<string, unknown>) => void>();
    const workspaces = createWorkspaces({
      layout: s.layout,
      repos: s.repos,
      log: { ...silentLogger, warn },
    });

    const [head] = await workspaces.refresh();
    expect(head).toEqual({
      name: "shop",
      commit: sh(shop, "rev-parse", "HEAD").trim(),
      atDefault: false,
    });

    expect(warn).toHaveBeenCalledWith(
      "could not refresh a repository",
      expect.objectContaining({ repo: "shop" }),
    );
  });

  it("reports a clone with local changes and leaves it alone before a chat session", async () => {
    const s = await setup();
    const shop = join(s.dir, "home/repos/shop");
    writeFileSync(join(shop, "README.md"), "# changed by hand\n");
    const before = sh(shop, "rev-parse", "HEAD").trim();
    pushSeed(s, "shop", "NEW.md");
    const warn = vi.fn<(message: string, data?: Record<string, unknown>) => void>();
    const workspaces = createWorkspaces({
      layout: s.layout,
      repos: s.repos,
      log: { ...silentLogger, warn },
    });

    const [head] = await workspaces.refresh();
    expect(head).toEqual({ name: "shop", commit: before, atDefault: false });
    expect(readFileSync(join(shop, "README.md"), "utf8")).toBe("# changed by hand\n");
    expect(warn).toHaveBeenCalledWith(
      "a base clone has local changes, so it was not moved to the default branch",
      expect.objectContaining({ repo: "shop" }),
    );
  });

  it("reports a clone it cannot move and keeps going", async () => {
    const s = await setup();
    const shop = join(s.dir, "home/repos/shop");
    pushSeed(s, "shop", "CLASH.md");
    // An untracked file the incoming commit would overwrite stops the checkout.
    writeFileSync(join(shop, "CLASH.md"), "mine\n");
    const warn = vi.fn<(message: string, data?: Record<string, unknown>) => void>();
    const workspaces = createWorkspaces({
      layout: s.layout,
      repos: s.repos,
      log: { ...silentLogger, warn },
    });

    const [head] = await workspaces.refresh();
    expect(head!.atDefault).toBe(false);
    expect(readFileSync(join(shop, "CLASH.md"), "utf8")).toBe("mine\n");
    expect(warn).toHaveBeenCalledWith(
      "could not move a base clone to the default branch",
      expect.objectContaining({ repo: "shop" }),
    );
  });

  it("never runs git in one clone for a round and a chat session at once", async () => {
    const s = await setup();
    const shop = join(s.dir, "home/repos/shop");
    let active = 0;
    let most = 0;
    const git: RunGit = async (args, o) => {
      if (o?.cwd !== shop) {
        return runGit(args, o);
      }

      active += 1;
      most = Math.max(most, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return await runGit(args, o);
      } finally {
        active -= 1;
      }
    };

    const workspaces = createWorkspaces({ layout: s.layout, repos: s.repos, git });
    pushSeed(s, "shop", "BUSY.md");
    await Promise.all([
      workspaces.prepare(offer("w5")),
      workspaces.refresh(),
      workspaces.prepare(offer("w6")),
      workspaces.refresh(),
    ]);

    expect(most).toBe(1);
    expect(existsSync(join(shop, "BUSY.md"))).toBe(true);
  });

  it("keeps the branch the agent created when the worktree is prepared again, and stays detached otherwise", async () => {
    const s = await setup();
    const w = await s.workspaces.prepare(offer("w4"));
    expect(w!.branch).toBeUndefined();
    expect((await s.workspaces.prepare(offer("w4")))!.branch).toBeUndefined();

    sh(w!.worktree, "switch", "-q", "-c", "feat/ACME-4-kept");
    writeFileSync(join(w!.worktree, "kept.txt"), "kept\n");
    sh(w!.worktree, "add", ".");
    sh(w!.worktree, "commit", "-q", "-m", "kept");
    expect((await s.workspaces.prepare(offer("w4")))!.branch).toBe("feat/ACME-4-kept");

    // Released with a branch the agent made: the commits survive on it.
    await s.workspaces.release("w4");
    expect(sh(join(s.dir, "home/repos/shop"), "branch", "--list", "feat/ACME-4-kept")).toContain(
      "feat/ACME-4-kept",
    );
  });

  describe("on a pull request's own branch", () => {
    const pr = (extra: Record<string, unknown> = {}) => ({
      type: "pr",
      ref: "acme-example/shop#3",
      headRef: "feat/x",
      baseRef: "main",
      state: "open",
      own: true,
      ...extra,
    });

    const withBranch = async (s: Awaited<ReturnType<typeof setup>>, name: string) => {
      const seed = join(s.dir, "seed/shop");
      sh(seed, "checkout", "-q", "-b", name);
      writeFileSync(join(seed, "PR.md"), "pr\n");
      sh(seed, "add", ".");
      sh(seed, "commit", "-q", "-m", "pr");
      sh(seed, "push", "-q", s.bare("shop"), name);
      sh(seed, "checkout", "-q", "main");
    };

    const roundOn = (
      id: string,
      kind: string,
      subject: { type: string; ref: string },
      subjects: unknown[],
    ) => {
      const o = offer(id, { subjects } as Partial<Offer["context"]>, kind);
      o.workItem.subject = subject;
      return o;
    };

    it("works a review round on the head of the pull request", async () => {
      const s = await setup();
      await withBranch(s, "feat/x");
      const w = await s.workspaces.prepare(
        roundOn("r1", "review_feedback", { type: "pr", ref: pr().ref }, [pr()]),
      );

      expect(w!.branch).toBe("feat/x");
      expect(readFileSync(join(w!.worktree, "PR.md"), "utf8")).toBe("pr\n");
      expect(sh(w!.worktree, "rev-parse", "HEAD").trim()).toBe(
        sh(w!.worktree, "rev-parse", "origin/feat/x").trim(),
      );

      // A resumed worktree keeps its branch.
      const again = await s.workspaces.prepare(
        roundOn("r1", "review_feedback", { type: "pr", ref: pr().ref }, [pr()]),
      );

      expect(again!.branch).toBe("feat/x");
    });

    it("pushes by name when a waiting item still holds the head branch", async () => {
      const s = await setup();
      await withBranch(s, "feat/x");
      const ticket = { type: "ticket", ref: "ACME-1" };
      const first = await s.workspaces.prepare(roundOn("t2", "assigned", ticket, [pr()]));
      expect(first!.branch).toBe("feat/x");

      const round = await s.workspaces.prepare(
        roundOn("r2", "conflict", { type: "pr", ref: pr().ref }, [pr()]),
      );

      expect(round!.branch).toBe("feat/x-r2");
      expect(sh(round!.worktree, "rev-parse", "HEAD").trim()).toBe(
        sh(round!.worktree, "rev-parse", "origin/feat/x").trim(),
      );
    });

    it("uses the only open pull request of a ticket", async () => {
      const s = await setup();
      await withBranch(s, "feat/x");
      const t = { type: "ticket", ref: "ACME-1" };
      const w = await s.workspaces.prepare(
        roundOn("t1", "assigned", t, [
          { ...t },
          pr(),
          pr({ ref: "acme-example/shop#4", headRef: "feat/old", state: "merged" }),
        ]),
      );

      expect(w!.branch).toBe("feat/x");
    });

    it("names no branch for new work, other people's and several pull requests", () => {
      const t = { type: "ticket", ref: "ACME-1" };
      const prSubject = { type: "pr", ref: pr().ref };
      const head = (o: Offer) => headBranchOf(o);
      expect(head(roundOn("a", "assigned", t, [{ ...t }]))).toBeUndefined();
      expect(head(roundOn("b", "assigned", t, [pr({ own: false })]))).toBeUndefined();
      expect(
        head(roundOn("c", "assigned", t, [pr(), pr({ ref: "acme-example/shop#5" })])),
      ).toBeUndefined();

      expect(
        head(roundOn("d", "review_feedback", prSubject, [pr({ state: "closed" })])),
      ).toBeUndefined();

      expect(
        head(roundOn("e", "merged_feedback", prSubject, [pr({ state: "merged" })])),
      ).toBeUndefined();

      expect(head(roundOn("f", "merged_feedback", prSubject, [pr()]))).toBeUndefined();
    });

    it("starts a new ticket detached at the default branch", async () => {
      const s = await setup();
      const t = { type: "ticket", ref: "ACME-2" };
      const w = await s.workspaces.prepare(roundOn("assigned-7", "assigned", t, [{ ...t }]));
      expect(w!.branch).toBeUndefined();
      expect(sh(w!.worktree, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("HEAD");
    });
  });

  it("has no workspace when no repo is writable and none is named", async () => {
    const s = await setup();
    const readOnly = createWorkspaces({
      layout: s.layout,
      repos: s.repos.filter((r) => r.access === "read"),
    });

    expect(await readOnly.prepare(offer("w5"))).toBeUndefined();
  });

  describe("a repository that could not be prepared at start", () => {
    /** shop, the primary repository, is not where its URL points until `fix()` moves it there. */
    async function unprepared() {
      const r = remotes(["shop", "design-system"]);
      const { vcs, ready } = samVcs();
      await ready;
      const home = join(r.dir, "home");
      const layout = { worktreesDir: join(home, "worktrees"), scratchDir: join(home, "scratch") };
      const moved = join(r.dir, "remote/acme-new/shop.git");
      const repos = await syncRepositories({
        team: acmeTeam(),
        person: "sam",
        vcs,
        profile: "code",
        reposDir: join(home, "repos"),
        remoteUrl: (x) => (x.name === "shop" ? moved : r.bare(x.name)),
      });

      let now = 1_000_000;
      const workspaces = createWorkspaces({
        layout,
        repos: repos.ready,
        unprepared: repos,
        now: () => now,
      });

      const fix = () => {
        mkdirSync(join(r.dir, "remote/acme-new"), { recursive: true });
        renameSync(r.bare("shop"), moved);
      };

      const later = (ms: number) => void (now += ms);
      return { ...r, layout, repos, workspaces, fix, later };
    }

    it("is prepared on worktree add once fixed, and the refusal names the error until then", async () => {
      const s = await unprepared();
      await expect(s.workspaces.add("y1", "shop")).rejects.toMatchObject({
        code: "unavailable",
        message: expect.stringMatching(
          /^shop could not be prepared, so no worktree is added: git clone failed: .*does not exist/,
        ) as string,
      });

      s.fix();
      expect(await s.workspaces.add("y1", "acme-example/shop")).toMatchObject({
        repo: "shop",
        existed: false,
      });

      expect(existsSync(join(s.layout.worktreesDir, "shop/y1/README.md"))).toBe(true);
      expect(s.repos.unprepared()).toEqual([]);
      expect(s.workspaces.worktrees().map((w) => w.repo)).toEqual(["shop"]);
    });

    it("is tried again at the start of a round that may need it, at most once a minute", async () => {
      const s = await unprepared();
      // Nothing is named and no prepared repository is writable: the round may need shop.
      expect(await s.workspaces.prepare(offer("y2"))).toBeUndefined();
      s.fix();
      s.later(30_000);
      expect(await s.workspaces.prepare(offer("y2"))).toBeUndefined();
      s.later(30_000);
      expect((await s.workspaces.prepare(offer("y2")))?.repo).toBe("shop");
    });

    it("is tried again for a round that names it, and not for one that names a prepared repository", async () => {
      const s = await unprepared();
      const retry = vi.spyOn(s.repos, "retry");
      const ds = "https://github.com/acme-example/design-system/pull/3";
      await s.workspaces.prepare(offer("y3", { subjects: [{ type: "pr", ref: "3", url: ds }] }));
      expect(retry).not.toHaveBeenCalled();

      s.fix();
      const url = "https://github.com/acme-example/shop/issues/4";
      const named = offer("y4", { links: [{ url, title: "shop#4" }] });
      expect((await s.workspaces.prepare(named))?.repo).toBe("shop");
      expect(retry).toHaveBeenCalledWith("shop");
    });

    it("is tried again before a chat session reads the clones", async () => {
      const s = await unprepared();
      expect((await s.workspaces.refresh()).map((h) => h.name)).toEqual(["design-system"]);
      s.fix();
      s.later(60_000);
      expect((await s.workspaces.refresh()).map((h) => h.name)).toEqual(["design-system", "shop"]);
    });
  });

  describe("a worktree added to an item in another repository", () => {
    /** sam may write design-system too in these tests. */
    async function wider() {
      const s = await setup();
      const repos = s.repos.map((r) =>
        r.name === "design-system" ? { ...r, access: "write" as const } : r,
      );

      return { ...s, workspaces: createWorkspaces({ layout: s.layout, repos }) };
    }

    it("is added detached at the default branch, found again, listed in later rounds and released", async () => {
      const s = await wider();
      await s.workspaces.prepare(offer("x1"));
      const added = await s.workspaces.add("x1", "design-system");
      const worktree = join(s.layout.worktreesDir, "design-system/x1");
      expect(added).toEqual({ repo: "design-system", worktree, branch: undefined, existed: false });
      expect(sh(worktree, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("HEAD");

      expect(await s.workspaces.add("x1", "acme-example/design-system")).toMatchObject({
        existed: true,
      });

      const next = await s.workspaces.prepare(offer("x1"));
      expect(next!.others).toEqual([{ repo: "design-system", worktree }]);
      expect(s.workspaces.worktrees()).toEqual(
        expect.arrayContaining([
          { repo: "shop", dir: "x1", root: join(s.layout.worktreesDir, "shop/x1") },
          { repo: "design-system", dir: "x1", root: worktree },
        ]),
      );

      await s.workspaces.release("x1");
      expect(existsSync(worktree)).toBe(false);
    });

    it("checks out a branch: the remote one when it exists, else a new one", async () => {
      const s = await wider();
      const seed = join(s.dir, "seed/design-system");
      sh(seed, "checkout", "-q", "-b", "feat/kit");
      writeFileSync(join(seed, "KIT.md"), "kit\n");
      sh(seed, "add", ".");
      sh(seed, "commit", "-q", "-m", "kit");
      sh(seed, "push", "-q", s.bare("design-system"), "feat/kit");

      const remote = await s.workspaces.add("x2", "design-system", "feat/kit");
      expect(remote).toMatchObject({ branch: "feat/kit", existed: false });
      expect(existsSync(join(s.layout.worktreesDir, "design-system/x2/KIT.md"))).toBe(true);

      const fresh = await s.workspaces.add("x3", "design-system", "feat/new");
      expect(fresh).toMatchObject({ branch: "feat/new" });
    });

    it("refuses a branch another item's worktree has checked out, naming that worktree", async () => {
      const s = await wider();
      await s.workspaces.add("x4", "design-system", "feat/held");
      expect(await s.workspaces.add("x5", "design-system", "feat/held")).toEqual({
        repo: "design-system",
        heldBy: expect.stringMatching(/worktrees\/design-system\/x4$/) as string,
      });

      expect(existsSync(join(s.layout.worktreesDir, "design-system/x5"))).toBe(false);
    });

    it("refuses a repository the person can only read, or has no grant on", async () => {
      const s = await setup();
      await expect(s.workspaces.add("x6", "design-system")).rejects.toMatchObject({
        code: "forbidden",
        message: expect.stringMatching(/only read design-system/) as string,
      });

      await expect(s.workspaces.add("x6", "infra")).rejects.toMatchObject({
        code: "forbidden",
        message: expect.stringMatching(/no grant on "infra".*shop, design-system/) as string,
      });
    });
  });
});

describe("convention files", () => {
  it("finds the files a repository states its rules in, and the configured extras that exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "ost-conv-"));
    expect(findConventionFiles(dir)).toEqual([]);
    mkdirSync(join(dir, ".github"), { recursive: true });
    writeFileSync(join(dir, "CONTRIBUTING.md"), "One commit per pull request.\n");
    writeFileSync(join(dir, ".github", "pull_request_template.md"), "## Why\n");
    writeFileSync(join(dir, "CLAUDE.md"), "Be a pirate.\n");
    mkdirSync(join(dir, "AGENTS.md"));

    // A project CLAUDE.md is not a convention file unless the team lists it; a directory is not a file.
    expect(findConventionFiles(dir)).toEqual([
      "CONTRIBUTING.md",
      ".github/pull_request_template.md",
    ]);

    expect(findConventionFiles(dir, ["CLAUDE.md", "MISSING.md"])).toEqual([
      "CONTRIBUTING.md",
      ".github/pull_request_template.md",
      "CLAUDE.md",
    ]);
  });
});
