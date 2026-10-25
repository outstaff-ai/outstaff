// Assertions live in the `rejects` and `expectLinks` helpers.
/* oxlint-disable vitest/expect-expect */
import { AdapterRegistry, PortError, buildPolicy, defineAdapter, repoAccess } from "@outstaff/core";
import { createFakeAdapterRegistry } from "@outstaff/core/fakes";
import { envSecretSource } from "@outstaff/core";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  VERBS,
  createAgentEnv,
  createFakeOffice,
  createRuntimeTools,
  describeVerb,
  findVerb,
  renderVerbsReference,
  runVerb,
  toolName,
} from "./index.js";
import { agentLayout } from "../runner/layout.js";
import { acmeTeam, fakeEnv } from "./testing.js";

const verb = (name: string) => findVerb(name)!;
const run = (name: string, env: ReturnType<typeof fakeEnv>["env"], input: unknown = {}, ctx = {}) =>
  runVerb(verb(name), env, input, ctx);

const rejects = async (p: Promise<unknown>, code: string, message?: RegExp) => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );

  expect(e).toBeInstanceOf(PortError);
  expect((e as PortError).code).toBe(code);
  if (message) {
    expect((e as PortError).message).toMatch(message);
  }
};

const expectLinks = (r: { text: string; links: string[] }, n = 1) => {
  expect(r.links.length).toBeGreaterThanOrEqual(n);
  for (const l of r.links) {
    expect(l).toMatch(/^https:\/\//);
    expect(r.text).toContain(l);
  }
};

describe("ticket verbs", () => {
  it("shows a ticket with its comments and links", async () => {
    const { env, tracker } = fakeEnv();
    const issue = await tracker.createIssue({ title: "Fix cart", body: "It breaks." });
    await tracker.comment(issue.key, "Looking into it");
    const r = await run("ticket.show", env, { key: issue.key });
    expect(r.text).toContain("Fix cart");
    expect(r.text).toContain("Looking into it");
    expect(r.links).toContain(tracker.links.issue(issue.key));
    expectLinks(r, 2);
    expect((r.data as { comments: unknown[] }).comments).toHaveLength(1);
  });

  it("comments", async () => {
    const { env, tracker } = fakeEnv();
    const issue = await tracker.createIssue({ title: "T", body: "" });
    const r = await run("ticket.comment", env, { key: issue.key, body: "Done." });
    expectLinks(r, 2);
    expect(await tracker.listComments(issue.key)).toHaveLength(1);
  });

  it("moves to a canonical status", async () => {
    const { env, tracker } = fakeEnv();
    const issue = await tracker.createIssue({ title: "T", body: "" });
    const r = await run("ticket.move", env, { key: issue.key, to: "review" });
    expect((await tracker.getIssue(issue.key)).status.canonical).toBe("review");
    expectLinks(r);
  });

  it("assigns to me, to a named member and to nobody", async () => {
    const { env, tracker } = fakeEnv();
    const sam = await tracker.seed.member({ name: "sam", kind: "agent" });
    const priya = await tracker.seed.member({ name: "Priya Raman" });
    const issue = await tracker.createIssue({ title: "T", body: "" });

    const mine = await run("ticket.assign", env, { key: issue.key, to: "me" });
    expect((await tracker.getIssue(issue.key)).assignee?.id).toBe(sam.id);
    expectLinks(mine);

    await run("ticket.assign", env, { key: issue.key, to: "Priya Raman" });
    expect((await tracker.getIssue(issue.key)).assignee?.id).toBe(priya.id);

    await run("ticket.assign", env, { key: issue.key, to: "none" });
    expect((await tracker.getIssue(issue.key)).assignee).toBeUndefined();
    await rejects(run("ticket.assign", env, { key: issue.key, to: "ghost" }), "not_found");
  });

  it("reports a missing ticket", async () => {
    await rejects(run("ticket.show", fakeEnv().env, { key: "SHOP-99" }), "not_found");
  });

  it.each([
    ["ticket.show", {}],
    ["ticket.show", { key: "bad key" }],
    ["ticket.show", { key: "SHOP-1", extra: 1 }],
    ["ticket.comment", { key: "SHOP-1", body: "" }],
    ["ticket.move", { key: "SHOP-1", to: "deleted" }],
  ])("validates input of %s %j", async (name, input) => {
    await rejects(run(name, fakeEnv().env, input), "invalid", new RegExp(name));
  });
});

describe("doc verbs", () => {
  it("searches and shows with links", async () => {
    const { env, knowledge } = fakeEnv();
    const doc = await knowledge.seed.doc({
      path: "specs/cart.md",
      title: "Cart",
      body: "Cart spec",
    });

    await knowledge.comment(doc.id, { body: "Needs more detail" });
    const found = await run("doc.search", env, { query: "cart" });
    expect(found.links).toEqual([knowledge.links.doc(doc.id)]);
    expectLinks(found);

    const shown = await run("doc.show", env, { id: doc.path });
    expect(shown.text).toContain("Needs more detail");
    expectLinks(shown);
    expect((await run("doc.search", env, { query: "nothing" })).text).toContain("No documents");
  });

  it("creates but never overwrites", async () => {
    const { env } = fakeEnv();
    const input = { path: "specs/new.md", title: "New", body: "Text" };
    expectLinks(await run("doc.create", env, input));
    await rejects(run("doc.create", env, input), "conflict");
  });

  it("replies and resolves only comments that belong to the document", async () => {
    const { env, knowledge } = fakeEnv();
    const a = await knowledge.seed.doc({ path: "a.md", title: "A", body: "" });
    const b = await knowledge.seed.doc({ path: "b.md", title: "B", body: "" });
    const c = await knowledge.comment(a.id, { body: "Question" });

    expectLinks(await run("doc.reply", env, { doc: a.id, commentId: c.id, body: "Answer" }));
    const resolved = await run("doc.resolve", env, { doc: a.id, commentId: c.id });
    expectLinks(resolved);
    expect((await knowledge.comments(a.id)).find((x) => x.id === c.id)?.resolved).toBe(true);
    await rejects(run("doc.resolve", env, { doc: b.id, commentId: c.id }), "not_found");
  });

  it.each([
    ["doc.create", { path: "../x.md", title: "t", body: "b" }],
    ["doc.create", { path: "/etc/x.md", title: "t", body: "b" }],
    ["doc.search", { query: "x", limit: 0 }],
    ["doc.reply", { doc: "a", commentId: "c" }],
  ])("validates input of %s %j", async (name, input) => {
    await rejects(run(name, fakeEnv().env, input), "invalid");
  });
});

describe("pr verbs", () => {
  async function withPr() {
    const f = fakeEnv();
    const repo = f.vcs.seed.repo;
    const pr = await f.vcs.seed.pullRequest(repo, {
      title: "Add cart",
      mergeable: ["unknown", "clean"],
    });

    await f.vcs.seed.check(repo, pr.head.sha, { name: "ci", status: "failure" });
    const thread = await f.vcs.seed.thread(repo, pr.number, {
      path: "src/cart.ts",
      line: 3,
      comments: [
        { author: "reviewer", body: "Why?" },
        { author: "sam", body: "Because." },
      ],
    });

    return { ...f, repo, pr, thread };
  }

  // The fake's repos are acme/app; map the team repo "shop" onto them.
  const shop = (f: Awaited<ReturnType<typeof withPr>>) => {
    f.env.team.repos[0]!.url = `${f.repo.host}/${f.repo.owner}/${f.repo.name}`;
    return "shop";
  };

  it("shows status with checks, threads and links", async () => {
    const f = await withPr();
    const r = await run("pr.status", f.env, { repo: shop(f), number: f.pr.number });
    expect(r.text).toContain("mergeable: clean");
    expect(r.text).toContain("Open review threads: 1");
    expect(r.text).toContain("failing: ci");
    expect(r.links).toContain(f.pr.url);
    expectLinks(r, 1);
  });

  it("lists open threads, and resolved ones with all", async () => {
    const f = await withPr();
    const repo = shop(f);
    const open = await run("pr.threads", f.env, { repo, number: f.pr.number });
    expect(open.text).toContain("src/cart.ts:3");
    expect(open.links).toContain(f.vcs.links.thread(f.repo, f.pr.number, f.thread));
    await run("pr.resolve", f.env, { repo, number: f.pr.number, thread: f.thread });
    expect((await run("pr.threads", f.env, { repo, number: f.pr.number })).text).toContain(
      "No open review threads",
    );

    expect(
      (await run("pr.threads", f.env, { repo, number: f.pr.number, all: true })).text,
    ).toContain("[resolved]");
  });

  it("resolves a thread whose last comment is mine", async () => {
    const f = await withPr();
    const r = await run("pr.resolve", f.env, {
      repo: shop(f),
      number: f.pr.number,
      thread: f.thread,
    });

    expectLinks(r);
    expect((await f.vcs.reviewThreads(f.repo, f.pr.number))[0]!.resolved).toBe(true);
  });

  it("refuses to resolve a thread whose last comment is not mine, and keeps it open", async () => {
    const f = await withPr();
    const other = await f.vcs.seed.thread(f.repo, f.pr.number, {
      comments: [
        { author: "sam", body: "Fixed" },
        { author: "reviewer", body: "Not yet" },
      ],
    });

    await rejects(
      run("pr.resolve", f.env, { repo: shop(f), number: f.pr.number, thread: other }),
      "forbidden",
      /https:\/\//,
    );

    expect(
      (await f.vcs.reviewThreads(f.repo, f.pr.number)).find((t) => t.id === other)?.resolved,
    ).toBe(false);

    await rejects(
      run("pr.resolve", f.env, { repo: shop(f), number: f.pr.number, thread: "nope" }),
      "not_found",
    );
  });

  it("accepts host/owner/name of a team repo and refuses other repositories", async () => {
    const f = await withPr();
    shop(f);
    await run("pr.status", f.env, {
      repo: `${f.repo.host}/${f.repo.owner}/${f.repo.name}`,
      number: 1,
    });

    await rejects(
      run("pr.status", f.env, { repo: "github.com/other/thing", number: 1 }),
      "not_found",
    );

    await rejects(run("pr.status", f.env, { repo: "nothing", number: 1 }), "not_found");
  });

  it.each([
    ["pr.status", { repo: "shop", number: 0 }],
    ["pr.status", { repo: "shop", number: 1.5 }],
    ["pr.threads", { repo: "shop", number: "1" }],
    ["pr.resolve", { repo: "shop", number: 1 }],
  ])("validates input of %s %j", async (name, input) => {
    await rejects(run(name, fakeEnv().env, input), "invalid");
  });
});

describe("pr write verbs", () => {
  async function setup(level: "write" | "read" = "write") {
    const f = fakeEnv();
    const repo = f.vcs.seed.repo;
    f.env.team.repos[0]!.url = `${repo.host}/${repo.owner}/${repo.name}`;
    await f.vcs.seed.permission(repo, "sam", level);
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ost-pr-")));
    const layout = agentLayout(root, join(root, "secrets"));
    const dir = join(layout.worktreesDir, "shop");
    const scratch = join(layout.scratchDir, "w1");
    for (const d of [dir, scratch, layout.secretsDir]) {
      mkdirSync(d, { recursive: true });
    }

    f.env.layout = layout;
    f.env.policy = buildPolicy({
      profile: "code",
      person: f.env.team.people.find((p) => p.handle === "sam")!,
      team: f.env.team,
      layout,
    });

    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
    git("init", "-q", "-b", "feat/coupons");
    git("remote", "add", "origin", `https://${repo.host}/${repo.owner}/${repo.name}.git`);

    /** A file in the item's scratch directory; returns its path. */
    const file = (name: string, text: string) => {
      writeFileSync(join(scratch, name), text);
      return join(scratch, name);
    };

    const theirs = () =>
      f.vcs.seed.pullRequest(repo, {
        title: "Theirs",
        author: { login: "noor", kind: "agent" },
      });

    return {
      ...f,
      repo,
      dir,
      git,
      file,
      theirs,
      layout,
      scratch,
      ctx: { cwd: dir, workItemId: "w1" },
    };
  }

  it("opens from the worktree's branch and origin, with the body from a file, and links it", async () => {
    const f = await setup();
    const r = await run(
      "pr.open",
      f.env,
      { title: "feat(cart): coupons", bodyFile: f.file("pr.md", "Closes #1"), draft: true },
      f.ctx,
    );

    const pr = await f.vcs.getPullRequest(f.repo, 1);
    expect(pr).toMatchObject({
      title: "feat(cart): coupons",
      body: "Closes #1",
      draft: true,
      head: { ref: "feat/coupons" },
      base: { ref: "main" },
      author: { login: "sam" },
    });

    expect(r.links).toEqual([pr.url]);
    expect(r.text).toContain(pr.url);
    expect((await f.vcs.events([f.repo])).events.at(-1)).toMatchObject({
      type: "pr.opened",
      actor: "sam",
    });
  });

  describe("files the caller names", () => {
    const body = (path: string) => ({ title: "x", bodyFile: path });

    it("reads a normal file in the item's scratch directory or worktree", async () => {
      const f = await setup();
      writeFileSync(join(f.dir, "notes.md"), "from the worktree");
      await run("pr.open", f.env, body(f.file("pr.md", "from scratch")), f.ctx);
      await run("pr.open", f.env, { ...body("notes.md"), head: "feat/b" }, f.ctx);
      expect((await f.vcs.getPullRequest(f.repo, 1)).body).toBe("from scratch");
      expect((await f.vcs.getPullRequest(f.repo, 2)).body).toBe("from the worktree");
    });

    it("refuses a file in the secrets directory without leaking it", async () => {
      const f = await setup();
      const secret = join(f.layout.secretsDir, "GH_APP_PRIVATE_KEY");
      writeFileSync(secret, "TOP-SECRET");
      const e = await run("pr.open", f.env, body(secret), f.ctx).catch((err: unknown) => err);
      expect(e).toBeInstanceOf(PortError);
      expect((e as PortError).message).not.toContain("TOP-SECRET");
      expect((e as PortError).message).toMatch(/Refusing to read body file/);
      expect(await f.vcs.listPullRequests(f.repo)).toEqual([]);
    });

    it("refuses a .env in the worktree", async () => {
      const f = await setup();
      writeFileSync(join(f.dir, ".env"), "TOKEN=abc");
      await rejects(run("pr.open", f.env, body(".env"), f.ctx), "invalid", /read policy/);
    });

    it("refuses a symlink in scratch that points at a secret", async () => {
      const f = await setup();
      const secret = join(f.layout.secretsDir, "key");
      writeFileSync(secret, "TOP-SECRET");
      symlinkSync(secret, join(f.scratch, "innocent.md"));
      await rejects(
        run("pr.open", f.env, body(join(f.scratch, "innocent.md")), f.ctx),
        "invalid",
        /Refusing to read/,
      );

      const outside = join(f.layout.home, "elsewhere.md");
      writeFileSync(outside, "x");
      symlinkSync(outside, join(f.scratch, "link.md"));
      await rejects(run("pr.open", f.env, body(join(f.scratch, "link.md")), f.ctx), "invalid");
    });

    it("refuses a path outside the worktree and the scratch directory, and the comment file too", async () => {
      const f = await setup();
      const outside = join(f.layout.memoryDir, "notes.md");
      mkdirSync(f.layout.memoryDir, { recursive: true });
      writeFileSync(outside, "memory");
      await rejects(run("pr.open", f.env, body(outside), f.ctx), "invalid", /outside the worktree/);
      await rejects(run("pr.open", f.env, body("../../scratch/other/x.md"), f.ctx), "invalid");

      const pr = await f.theirs();
      await rejects(
        run("pr.review", f.env, { number: pr.number, comment: true, commentFile: outside }, f.ctx),
        "invalid",
        /outside the worktree/,
      );
    });

    it("refuses every file when the environment has no policy", async () => {
      const f = await setup();
      delete f.env.policy;
      await rejects(
        run("pr.open", f.env, body(f.file("pr.md", "x")), f.ctx),
        "invalid",
        /not available/,
      );
    });
  });

  it("takes repo, head and base explicitly and needs no worktree for them", async () => {
    const f = await setup();
    const r = await run("pr.open", f.env, {
      repo: "shop",
      head: "feat/x",
      base: "release",
      title: "x",
      body: "y",
    });

    expect(await f.vcs.getPullRequest(f.repo, 1)).toMatchObject({ base: { ref: "release" } });
    expectLinks(r);
    await rejects(
      run("pr.open", f.env, { repo: "shop", title: "x", body: "y" }),
      "invalid",
      /--head/,
    );
  });

  it("refuses the default branch, a missing or doubled body and a reader's write", async () => {
    const f = await setup();
    f.git("checkout", "-q", "-b", "main");
    await rejects(
      run("pr.open", f.env, { title: "x", body: "y" }, f.ctx),
      "invalid",
      /default branch/,
    );

    f.git("checkout", "-q", "-b", "feat/z");
    await rejects(run("pr.open", f.env, { title: "x" }, f.ctx), "invalid", /body/);
    await rejects(
      run("pr.open", f.env, { title: "x", body: "y", bodyFile: "pr.md" }, f.ctx),
      "invalid",
      /not both/,
    );

    await rejects(run("pr.open", f.env, { title: "x", bodyFile: "missing.md" }, f.ctx), "invalid");
    const reader = await setup("read");
    await rejects(
      run("pr.open", reader.env, { title: "x", body: "y" }, reader.ctx),
      "forbidden",
      /write grant/,
    );
  });

  it("updates the pull request and refuses an empty or contradictory update", async () => {
    const f = await setup();
    await run("pr.open", f.env, { title: "Before", body: "old", draft: true }, f.ctx);
    const r = await run("pr.update", f.env, { number: 1, title: "After", ready: true }, f.ctx);
    expect(await f.vcs.getPullRequest(f.repo, 1)).toMatchObject({ title: "After", draft: false });
    expectLinks(r);
    await run(
      "pr.update",
      f.env,
      { number: 1, bodyFile: f.file("b.md", "new"), draft: true },
      f.ctx,
    );

    expect(await f.vcs.getPullRequest(f.repo, 1)).toMatchObject({ body: "new", draft: true });
    await rejects(run("pr.update", f.env, { number: 1 }, f.ctx), "invalid", /Nothing to update/);
    await rejects(
      run("pr.update", f.env, { number: 1, draft: true, ready: true }, f.ctx),
      "invalid",
    );
  });

  it("reviews with a verdict, a body file and inline comments from a JSON file", async () => {
    const f = await setup("read");
    const pr = await f.theirs();
    const r = await run(
      "pr.review",
      f.env,
      {
        number: pr.number,
        requestChanges: true,
        bodyFile: f.file("review.md", "2 must-fix"),
        commentFile: f.file(
          "inline.json",
          JSON.stringify([{ path: "src/a.ts", line: 4, body: "rename" }]),
        ),
      },
      f.ctx,
    );

    expect(r.text).toContain("request changes");
    expect(r.links).toEqual([pr.url]);
    expect((await f.vcs.events([f.repo])).events.at(-1)).toMatchObject({
      type: "pr.review_submitted",
      actor: "sam",
      data: { state: "changes_requested", body: "2 must-fix" },
    });

    expect((await f.vcs.reviewThreads(f.repo, pr.number))[0]).toMatchObject({
      path: "src/a.ts",
      line: 4,
    });
  });

  it("insists on exactly one verdict, a body unless approving, and well-formed comments", async () => {
    const f = await setup();
    const pr = await f.theirs();
    const n = pr.number;
    await rejects(
      run("pr.review", f.env, { number: n, body: "x" }, f.ctx),
      "invalid",
      /exactly one/,
    );

    await rejects(
      run("pr.review", f.env, { number: n, approve: true, comment: true }, f.ctx),
      "invalid",
    );

    await rejects(run("pr.review", f.env, { number: n, comment: true }, f.ctx), "invalid", /body/);
    await run("pr.review", f.env, { number: n, approve: true }, f.ctx);
    await rejects(
      run(
        "pr.review",
        f.env,
        { number: n, comment: true, commentFile: f.file("bad.json", '[{"path":"a"}]') },
        f.ctx,
      ),
      "invalid",
      /array of/,
    );

    await rejects(
      run(
        "pr.review",
        f.env,
        { number: n, comment: true, commentFile: f.file("n.json", "nope") },
        f.ctx,
      ),
      "invalid",
      /not JSON/,
    );
  });

  it("refuses reviewing one's own pull request", async () => {
    const f = await setup();
    await run("pr.open", f.env, { title: "Mine", body: "x" }, f.ctx);
    await rejects(
      run("pr.review", f.env, { number: 1, approve: true }, f.ctx),
      "forbidden",
      /own pull request/,
    );
  });

  it("replies to a thread of that pull request and links it", async () => {
    const f = await setup();
    const pr = await f.theirs();
    const other = await f.theirs();
    const thread = await f.vcs.seed.thread(f.repo, pr.number, {
      comments: [{ author: "noor", body: "Why?" }],
    });

    const foreign = await f.vcs.seed.thread(f.repo, other.number, {
      comments: [{ author: "noor", body: "And?" }],
    });

    const r = await run("pr.reply", f.env, { number: pr.number, thread, body: "Because." }, f.ctx);
    expect((await f.vcs.reviewThreads(f.repo, pr.number))[0]!.comments.at(-1)).toMatchObject({
      author: "sam",
      body: "Because.",
    });

    expect(r.links).toContain(f.vcs.links.thread(f.repo, pr.number, thread));
    await rejects(
      run("pr.reply", f.env, { number: pr.number, thread: foreign, body: "x" }, f.ctx),
      "not_found",
    );

    await rejects(
      run("pr.reply", f.env, { number: pr.number, thread, body: "  " }, f.ctx),
      "invalid",
    );
  });

  it("comments on the conversation of a pull request", async () => {
    const f = await setup();
    const pr = await f.theirs();
    const r = await run("pr.comment", f.env, { number: pr.number, body: "Done." }, f.ctx);
    expect(r.links).toEqual([pr.url]);
    const sent = (await f.vcs.events([f.repo])).events.filter(
      (e) => e.type === "pr.comment" && e.data["kind"] === "comment",
    );

    expect(sent.map((e) => [e.actor, e.data["body"]])).toEqual([["sam", "Done."]]);
    await rejects(run("pr.comment", f.env, { number: pr.number, body: " " }, f.ctx), "invalid");
  });

  it("prints the diff after the link, needing only a read grant", async () => {
    const f = await setup("read");
    const pr = await f.theirs();
    const r = await run("pr.diff", f.env, { number: pr.number }, f.ctx);
    expect(r.text.split("\n")[1]).toBe(pr.url);
    expect(r.text).toContain("diff --git");
    expect(r.links).toEqual([pr.url]);
  });

  it("fails clearly outside a worktree and in a directory that is not one", async () => {
    const f = await setup();
    await rejects(run("pr.diff", f.env, { number: 1 }), "invalid", /--repo/);
    await rejects(run("pr.diff", f.env, { number: 1 }, { cwd: tmpdir() }), "invalid", /--repo/);
  });

  it("is exposed as runtime tools that run in the item's worktree", async () => {
    const f = await setup();
    const tools = createRuntimeTools(f.env, VERBS, f.ctx);
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "pr_open",
        "pr_update",
        "pr_review",
        "pr_reply",
        "pr_comment",
        "pr_diff",
      ]),
    );

    const open = tools.find((t) => t.name === "pr_open")!;
    expect(await open.handler({ title: "t", body: "b" }, {})).toContain("Opened");
    expect((await f.vcs.getPullRequest(f.repo, 1)).head.ref).toBe("feat/coupons");
  });
});

describe("me", () => {
  it("shows the person", async () => {
    const r = await run("me", fakeEnv().env);
    expect(r.text).toContain("Sam Duarte (sam)");
    expect(r.text).toContain("shop: write");
    expect(r.data).toMatchObject({ handle: "sam", role: "developer" });
  });

  it("lists the tools and names the ones that are unavailable", async () => {
    const f = fakeEnv();
    f.env.tools = [
      { name: "go", version: "1.23.4", state: "installed" },
      { name: "their-cli", version: "0.9.1", state: "unavailable", error: "404 not found" },
    ];

    const r = await run("me", f.env);
    expect(r.text).toContain("Tools: go 1.23.4; their-cli 0.9.1 UNAVAILABLE (404 not found)");
    expect((await run("me", fakeEnv().env)).text).toContain("Tools: none");
  });

  it("reports connected ports", async () => {
    const r = await run("me", fakeEnv({ tracker: false }).env);
    expect(r.data).toMatchObject({ connected: { tracker: false, knowledge: true } });
  });
});

describe("office verbs", () => {
  it("asks a teammate", async () => {
    const f = fakeEnv();
    const r = await run("ask", f.env, { to: "mira", question: "Ok?" }, { workItemId: "w1" });
    expect(r.text).toContain("mira answered: Yes.");
    expect(f.office.asked).toEqual([{ to: "mira", question: "Ok?", workItemId: "w1" }]);
    expect((await run("ask", f.env, { to: "noor", question: "Ok?" })).text).toContain(
      "no answer yet",
    );
  });

  it("validates who can be asked", async () => {
    const { env } = fakeEnv();
    await rejects(run("ask", env, { to: "sam", question: "Me?" }), "invalid");
    await rejects(run("ask", env, { to: "mira" }), "invalid");
  });

  it("lists work items with ticket links and marks the current one", async () => {
    const f = fakeEnv();
    const r = await run("work", f.env, {}, { workItemId: "w1" });
    expect(r.text).toContain("* w1 [active] Fix checkout");
    expect(r.text).toContain(
      `1. [SHOP-1 Fix checkout](${f.tracker.links.issue("SHOP-1")}) (running)`,
    );

    expect(r.links).toEqual([f.tracker.links.issue("SHOP-1")]);
    expectLinks(r);
  });

  it("moves a queued work item", async () => {
    const f = fakeEnv();
    const r = await run("work.move", f.env, { id: "w2", position: "after", relativeTo: "w3" });
    expect(r.text).toContain("Work item w2");
    expect(f.office.placed).toEqual([
      { workItemId: "w2", placement: { position: "after", relativeTo: "w3" } },
    ]);
  });

  it("creates a ticket for a chat session and files it as work", async () => {
    const f = fakeEnv();
    f.office.work = async () => [{ id: "c1", title: "Chat", status: "active", kind: "chat" }];
    const r = await run(
      "ticket.create",
      f.env,
      { title: "Add search", body: "Dana asked." },
      { workItemId: "c1" },
    );

    expect(r.text).toContain("Created SHOP-");
    expectLinks(r);
    expect(f.office.linked).toEqual([{ workItemId: "c1", ticket: "SHOP-1" }]);
    const issue = await f.tracker.getIssue("SHOP-1");
    expect(issue).toMatchObject({ title: "Add search" });
    expect(issue.status.canonical).toBe("ready");
    expect(r.text).toContain("Filed as work item");
  });

  it("files a request without a tracker from a chat session, and only from one", async () => {
    const f = fakeEnv({ tracker: false });
    const r = await run(
      "work.queue",
      f.env,
      { title: "Add search", body: "Dana asked." },
      { workItemId: "c1" },
    );

    expect(r.text).toContain('Queued "Add search".');
    expect(f.office.queued).toEqual([
      { workItemId: "c1", title: "Add search", body: "Dana asked." },
    ]);

    await rejects(run("work.queue", f.env, { title: "x" }), "invalid", /chat session/);
  });

  it("refuses a second ticket for an item that has one", async () => {
    const f = fakeEnv();
    await rejects(
      run("ticket.create", f.env, { title: "Again" }, { workItemId: "w1" }),
      "invalid",
      /already has ticket SHOP-1/,
    );

    expect(await f.tracker.listIssues({})).toHaveLength(0);
  });

  it("lists the team", async () => {
    expect((await run("team", fakeEnv().env)).text).toContain(
      "mira (Mira Okafor), architect: idle",
    );
  });

  it("answers a question", async () => {
    const f = fakeEnv();
    const r = await run("question.answer", f.env, { question: "q1", answer: "Yes." });
    expect(r.text).toContain("Answered question q1");
    expect(f.office.answered).toEqual([{ questionId: "q1", answer: "Yes." }]);
    await rejects(run("question.answer", f.env, { question: "q1" }), "invalid");
  });

  it("passes a role to the office and shows titles and humans in the team", async () => {
    const f = fakeEnv();
    await run("ask", f.env, { to: "architect", question: "Ok?" });
    expect(f.office.asked[0]?.to).toBe("architect");
    const office = createFakeOffice({
      team: [
        {
          handle: "mira",
          name: "Mira Okafor",
          role: "architect",
          title: "Architect",
          status: "working",
        },
      ],
      humans: [{ name: "Dana Reyes" }],
    });

    const r = await run("team", { ...f.env, office });
    expect(r.text).toContain("mira (Mira Okafor), Architect: working");
    expect(r.text).toContain("Humans: Dana Reyes");
  });

  it.each([
    ["ask", { to: "mira", question: "Hi?" }],
    ["work", {}],
    ["team", {}],
  ])("%s fails clearly without an office", async (name, input) => {
    await rejects(
      run(name, fakeEnv({ office: false }).env, input),
      "unavailable",
      /not connected to an office/,
    );
  });
});

describe("missing ports", () => {
  it.each([
    ["ticket.show", { key: "SHOP-1" }, /no tracker configured for this team/],
    ["ticket.comment", { key: "SHOP-1", body: "x" }, /no tracker/],
    ["ticket.move", { key: "SHOP-1", to: "done" }, /no tracker/],
    ["ticket.assign", { key: "SHOP-1", to: "me" }, /no tracker/],
  ])("%s without a tracker", async (name, input, message) => {
    await rejects(run(name, fakeEnv({ tracker: false }).env, input), "unsupported", message);
  });

  it.each([
    ["doc.search", { query: "x" }],
    ["doc.show", { id: "x" }],
    ["doc.create", { path: "a.md", title: "A", body: "" }],
    ["doc.reply", { doc: "x", commentId: "c", body: "b" }],
    ["doc.resolve", { doc: "x", commentId: "c" }],
  ])("%s without a knowledge base", async (name, input) => {
    await rejects(
      run(name, fakeEnv({ knowledge: false }).env, input),
      "unsupported",
      /no knowledge base configured for this team/,
    );
  });

  it("uses the reason recorded when a configured adapter could not start", async () => {
    const { env } = fakeEnv({ tracker: false });
    env.unavailable = { tracker: 'the tracker adapter "x" is not installed in this build' };
    await rejects(run("ticket.show", env, { key: "SHOP-1" }), "unsupported", /not installed/);
  });
});

describe("runtime tools", () => {
  it("has one tool per verb with an object schema and a safe name", () => {
    const tools = createRuntimeTools(fakeEnv().env);
    expect(tools.map((t) => t.name)).toEqual(VERBS.map(toolName));
    expect(tools.map((t) => t.name)).toContain("ticket_show");
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z_]+$/);
      expect((t.input as z.ZodObject).shape).toBeTypeOf("object");
      expect(t.description.length).toBeGreaterThan(10);
    }
  });

  it("runs a verb and returns its text with links", async () => {
    const { env, tracker } = fakeEnv();
    const issue = await tracker.createIssue({ title: "Fix cart", body: "" });
    const tool = createRuntimeTools(env).find((t) => t.name === "ticket_show")!;
    const text = await tool.handler({ key: issue.key }, {});
    expect(text).toContain(tracker.links.issue(issue.key));
  });

  it("passes the work item to office verbs", async () => {
    const f = fakeEnv();
    const tool = createRuntimeTools(f.env).find((t) => t.name === "ask")!;
    await tool.handler({ to: "mira", question: "Hi?" }, { workItemId: "w9" });
    expect(f.office.asked[0]?.workItemId).toBe("w9");
  });

  it("rejects invalid input and port errors", async () => {
    const tools = createRuntimeTools(fakeEnv({ tracker: false }).env);
    const get = (n: string) => tools.find((t) => t.name === n)!;
    await rejects(get("ticket_show").handler({}, {}), "invalid");
    await rejects(get("ticket_show").handler({ key: "SHOP-1" }, {}), "unsupported");
  });
});

describe("verb catalogue", () => {
  it("has the verbs of the issue and no destructive ones", () => {
    expect(VERBS.map((v) => v.name)).toEqual([
      "ticket.show",
      "ticket.comment",
      "ticket.move",
      "ticket.assign",
      "ticket.create",
      "doc.search",
      "doc.show",
      "doc.create",
      "doc.reply",
      "doc.resolve",
      "pr.status",
      "pr.threads",
      "pr.resolve",
      "pr.open",
      "pr.update",
      "pr.review",
      "pr.reply",
      "pr.comment",
      "pr.diff",
      "me",
      "ask",
      "question.answer",
      "work",
      "work.move",
      "work.queue",
      "team",
    ]);

    expect(VERBS.map((v) => v.name).join(" ")).not.toMatch(/delete|remove|merge|close|push|force/);
  });

  it("positional args exist in every schema", () => {
    for (const v of VERBS) {
      const names = describeVerb(v).map((f) => f.name);
      for (const a of v.args) {
        expect(names).toContain(a);
      }
    }
  });

  it("matches the committed reference page (run `pnpm --filter @outstaff/agent run docs:verbs`)", () => {
    const committed = readFileSync(
      new URL("../../../../docs/src/content/docs/reference/agent-verbs.md", import.meta.url),
      "utf8",
    );

    expect(committed).toBe(renderVerbsReference(VERBS));
  });
});

describe("createAgentEnv", () => {
  const fakeTeam = () => {
    const team = acmeTeam();
    for (const port of ["vcs", "tracker", "knowledge", "chat"] as const) {
      team.integrations[port] = { adapter: "fake" };
    }

    return team;
  };

  it("builds the ports from team.yaml and the registry", async () => {
    const env = await createAgentEnv({
      team: fakeTeam(),
      person: "sam",
      registry: createFakeAdapterRegistry(),
      secrets: envSecretSource({}, "/nonexistent"),
    });

    expect(env).toMatchObject({ person: "sam" });
    expect(env.tracker && env.knowledge && env.vcs && env.chat).toBeTruthy();
    expect(env.unavailable).toBeUndefined();
    await run("me", env);
  });

  it("leaves unconfigured ports unset and records unknown adapters", async () => {
    const team = fakeTeam();
    delete team.integrations.knowledge;
    team.integrations.tracker = { adapter: "itsaplan" };
    const env = await createAgentEnv({
      team,
      person: "sam",
      registry: createFakeAdapterRegistry(),
      secrets: envSecretSource({}, "/nonexistent"),
    });

    expect(env.knowledge).toBeUndefined();
    expect(env.unavailable?.knowledge).toBeUndefined();
    expect(env.unavailable?.tracker).toMatch(/itsaplan.*not installed/);
    await rejects(
      run("doc.search", env, { query: "x" }),
      "unsupported",
      /no knowledge base configured/,
    );

    await rejects(run("ticket.show", env, { key: "A-1" }), "unsupported", /itsaplan/);
  });

  it("leaves the vcs port absent for a person the adapter has no use for", async () => {
    const team = fakeTeam();
    const fake = createFakeAdapterRegistry().get("vcs", "fake")!;
    const registry = new AdapterRegistry().register(
      defineAdapter({
        ...fake,
        unavailableFor: ({ team: t, person }) =>
          repoAccess(t, person) === "none"
            ? `${person.handle} has no GitHub identity; ask a human or a teammate with repository access`
            : undefined,
      }),
    );

    for (const port of ["tracker", "knowledge", "chat"] as const) {
      delete team.integrations[port];
    }

    const base = { team, registry, secrets: envSecretSource({}, "/nonexistent") };
    const without = await createAgentEnv({ ...base, person: "leo" });
    expect(without.vcs).toBeUndefined();
    expect(without.unavailable?.vcs).toBe(
      "leo has no GitHub identity; ask a human or a teammate with repository access",
    );

    await rejects(
      run("pr.status", without, { repo: "shop", number: 1 }),
      "unsupported",
      /^leo has no GitHub identity; ask a human or a teammate with repository access$/,
    );

    const granted = await createAgentEnv({ ...base, person: "sam" });
    expect(granted.vcs).toBeTruthy();
    expect(granted.unavailable).toBeUndefined();
  });

  it("refuses an unknown person and carries the office", async () => {
    const base = {
      team: fakeTeam(),
      registry: createFakeAdapterRegistry(),
      secrets: envSecretSource({}, "/nonexistent"),
    };

    await rejects(createAgentEnv({ ...base, person: "ghost" }), "not_found");
    const office = fakeEnv().office;
    const env = await createAgentEnv({ ...base, person: "sam", office });
    expect(env.office).toBe(office);
  });
});
