import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger, type RepoRef, type Vcs } from "@outstaff/core";
import { createFakeVcs } from "@outstaff/core/fakes";
import { describe, expect, it, vi } from "vitest";
import type { Offer } from "../office-client/index.js";
import { acmeTeam } from "../verbs/testing.js";
import { cappedAccess, fileOnlySecrets } from "./access.js";
import { syncRepositories } from "./clone.js";
import {
  createCredentialHelper,
  parseCredentialRequest,
  repoForRequest,
} from "./credential-helper.js";
import { branchName, createWorkspaces, headBranchOf, repoForItem } from "./workspaces.js";

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
    const run = () =>
      syncRepositories({
        team: acmeTeam(),
        person: "sam",
        vcs,
        profile: "code",
        reposDir,
        remoteUrl: r.remoteUrl,
        log: silentLogger,
      });

    return { ...r, vcs, credentials, reposDir, run };
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
    const repos = await syncRepositories({
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
  });

  it("skips a repo it cannot reach and keeps the others", async () => {
    const s = await setup();
    const warn = vi.fn<(message: string, data?: Record<string, unknown>) => void>();
    const repos = await syncRepositories({
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
    const repos = await syncRepositories({
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
    const repos = await syncRepositories({
      team: acmeTeam(),
      person: "sam",
      vcs,
      profile: "code",
      reposDir: join(home, "repos"),
      remoteUrl: r.remoteUrl,
    });

    return { ...r, layout, repos, workspaces: createWorkspaces({ layout, repos }) };
  }

  it("names branches from kind, id and title", () => {
    expect(branchName({ id: "W42", kind: "ticket", title: "Fix the Checkout (again)!" })).toBe(
      "ticket/w42-fix-the-checkout-again",
    );

    expect(branchName({ id: "x", kind: "Review Round", title: "" })).toBe("review-round/x");
  });

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
      branch: "ticket/w1-fix-w1-now",
      worktree: join(s.layout.worktreesDir, "shop/w1"),
      scratch: join(s.layout.scratchDir, "w1"),
    });

    expect(readFileSync(join(w1!.worktree, "README.md"), "utf8")).toContain("shop");
    expect(sh(w1!.worktree, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(w1!.branch);
    expect(existsSync(w1!.scratch)).toBe(true);

    // Round two: the work of round one is still there.
    writeFileSync(join(w1!.worktree, "wip.txt"), "unfinished\n");
    const again = await s.workspaces.prepare(offer("w1"));
    expect(again).toEqual(w1);
    expect(readFileSync(join(w1!.worktree, "wip.txt"), "utf8")).toBe("unfinished\n");

    await s.workspaces.release("w1");
    expect(existsSync(w1!.worktree)).toBe(false);
    expect(existsSync(w1!.scratch)).toBe(false);
    // The branch survives, so nothing committed is lost.
    expect(sh(join(s.dir, "home/repos/shop"), "branch", "--list", w1!.branch)).toContain(
      w1!.branch,
    );
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

  it("builds on a branch someone else already pushed instead of overwriting it", async () => {
    const s = await setup();
    const seed = join(s.dir, "seed/shop");
    sh(seed, "checkout", "-q", "-b", "ticket/w3-fix-w3-now");
    writeFileSync(join(seed, "THEIRS.md"), "theirs\n");
    sh(seed, "add", ".");
    sh(seed, "commit", "-q", "-m", "theirs");
    sh(seed, "push", "-q", s.bare("shop"), "ticket/w3-fix-w3-now");

    const w = await s.workspaces.prepare(offer("w3"));
    expect(readFileSync(join(w!.worktree, "THEIRS.md"), "utf8")).toBe("theirs\n");
  });

  it("picks the branch up again after the worktree was removed", async () => {
    const s = await setup();
    const w = await s.workspaces.prepare(offer("w4"));
    writeFileSync(join(w!.worktree, "kept.txt"), "kept\n");
    sh(w!.worktree, "add", ".");
    sh(w!.worktree, "commit", "-q", "-m", "kept");
    await s.workspaces.release("w4");

    const back = await s.workspaces.prepare(offer("w4"));
    expect(readFileSync(join(back!.worktree, "kept.txt"), "utf8")).toBe("kept\n");
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

    it("keeps its own branch for new work, other people's and several pull requests", () => {
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

    it("gives a new ticket its own branch from the default branch", async () => {
      const s = await setup();
      const t = { type: "ticket", ref: "ACME-2" };
      const w = await s.workspaces.prepare(roundOn("assigned-7", "assigned", t, [{ ...t }]));
      expect(w!.branch).toBe("assigned/assigned-7-fix-assigned-7-now");
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
});
