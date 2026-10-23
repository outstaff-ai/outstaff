import { PortError } from "@outstaff/core";
import { VERBS, cliPath, createAgentEnv, createFakeOffice } from "@outstaff/agent";
import { createFakeAdapterRegistry } from "@outstaff/core/fakes";
import { envSecretSource } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { acmeTeam, fakeEnv } from "../../agent/src/verbs/testing.js";
import type { Context } from "./define.js";
import { run } from "./program.js";

async function ost(args: string[], f = fakeEnv(), env: Record<string, string> = {}) {
  let out = "";
  let err = "";
  const ctx: Context = {
    cwd: "/",
    env,
    out: (t) => void (out += t),
    err: (t) => void (err += t),
    gitOrigin: () => undefined,
    agentEnv: async () => f.env,
  };

  const code = await run(args, ctx);
  return { code, out, err, f };
}

describe("ost verbs", () => {
  it("registers one command per verb", async () => {
    const r = await ost(["--help"]);
    for (const group of ["ticket", "doc", "pr", "me", "ask", "work", "roster"]) {
      expect(r.out).toContain(group);
    }

    expect(VERBS.map((v) => cliPath(v).join(" "))).toContain("roster");
  });

  it("ticket show prints text with the link, and JSON with --json", async () => {
    const f = fakeEnv();
    const issue = await f.tracker.createIssue({ title: "Fix cart", body: "Broken" });
    const text = await ost(["ticket", "show", issue.key], f);
    expect(text.code).toBe(0);
    expect(text.out).toContain("Fix cart");
    expect(text.out).toContain(f.tracker.links.issue(issue.key));

    const json = await ost(["--json", "ticket", "show", issue.key], f);
    const parsed = JSON.parse(json.out);
    expect(parsed.links).toEqual([f.tracker.links.issue(issue.key)]);
    expect(parsed.text).toContain("Fix cart");
    expect(parsed.data.issue.key).toBe(issue.key);
  });

  it("ticket comment, move and assign", async () => {
    const f = fakeEnv();
    const issue = await f.tracker.createIssue({ title: "T", body: "" });
    await f.tracker.seed.member({ name: "sam", kind: "agent" });
    expect((await ost(["ticket", "comment", issue.key, "Hello there"], f)).code).toBe(0);
    expect((await f.tracker.listComments(issue.key))[0]?.body).toBe("Hello there");
    expect((await ost(["ticket", "move", issue.key, "review"], f)).code).toBe(0);
    expect((await f.tracker.getIssue(issue.key)).status.canonical).toBe("review");
    expect((await ost(["ticket", "assign", issue.key, "me"], f)).code).toBe(0);
    expect((await f.tracker.getIssue(issue.key)).assignee?.name).toBe("sam");
  });

  it("doc verbs, with options for title and body", async () => {
    const f = fakeEnv();
    const created = await ost(["doc", "create", "specs/a.md", "--title", "A", "--body", "Text"], f);
    expect(created.code).toBe(0);
    expect(created.out).toContain("https://");
    const doc = await f.knowledge.get("specs/a.md");
    const c = await f.knowledge.comment(doc.id, { body: "Q" });
    expect((await ost(["doc", "search", "text"], f)).out).toContain(f.knowledge.links.doc(doc.id));
    expect((await ost(["doc", "show", "specs/a.md"], f)).out).toContain("Q");
    expect((await ost(["doc", "reply", doc.id, c.id, "A!"], f)).code).toBe(0);
    expect((await ost(["doc", "resolve", doc.id, c.id], f)).code).toBe(0);
  });

  it("pr verbs coerce the number and take --all", async () => {
    const f = fakeEnv();
    f.env.team.repos[0]!.url = `${f.vcs.seed.repo.host}/${f.vcs.seed.repo.owner}/${f.vcs.seed.repo.name}`;
    const pr = await f.vcs.seed.pullRequest(f.vcs.seed.repo, { title: "Add cart" });
    const thread = await f.vcs.seed.thread(f.vcs.seed.repo, pr.number, {
      comments: [{ author: "sam", body: "Done" }],
    });

    expect((await ost(["pr", "status", "shop", "1"], f)).out).toContain(pr.url);
    expect((await ost(["pr", "threads", "shop", "1"], f)).out).toContain(thread);
    expect((await ost(["pr", "resolve", "shop", "1", thread], f)).code).toBe(0);
    expect((await ost(["pr", "threads", "shop", "1", "--all"], f)).out).toContain("[resolved]");
  });

  it("me, ask, work and roster", async () => {
    const f = fakeEnv();
    expect((await ost(["me"], f)).out).toContain("Sam Duarte");
    expect((await ost(["ask", "mira", "Ok?"], f)).out).toContain("Yes.");
    expect((await ost(["work"], f, { OUTSTAFF_WORK_ITEM: "w1" })).out).toContain("* w1");
    expect((await ost(["roster"], f)).out).toContain("mira");
    expect(f.office.asked).toHaveLength(1);
  });

  it("exits 1 with the code on stderr, or as JSON", async () => {
    const f = fakeEnv({ tracker: false });
    const text = await ost(["ticket", "show", "SHOP-1"], f);
    expect(text).toMatchObject({ code: 1, out: "" });
    expect(text.err).toBe("error    unsupported: no tracker configured for this team\n");

    const json = await ost(["--json", "ticket", "show", "SHOP-1"], f);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.out)).toEqual({
      error: { code: "unsupported", message: "no tracker configured for this team" },
    });
  });

  it("validates input", async () => {
    const r = await ost(["pr", "status", "shop", "abc"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^error {4}invalid: pr\.status: number/);
    expect((await ost(["ticket", "move", "SHOP-1", "deleted"])).err).toContain("invalid");
  });

  it("says when it is not connected to an office", async () => {
    const r = await ost(["work"], fakeEnv({ office: false }));
    expect(r.err).toContain("not connected to an office");
  });

  it("needs OUTSTAFF_PERSON when it builds the environment itself", async () => {
    let err = "";
    const code = await run(["me"], {
      cwd: "/",
      env: {},
      out: () => undefined,
      err: (t) => void (err += t),
      gitOrigin: () => undefined,
    });

    expect(code).toBe(1);
    expect(err).toContain("OUTSTAFF_PERSON");
  });

  it("builds its environment from the team file", async () => {
    // Same path the binary takes, with fakes instead of real adapters.
    const team = acmeTeam();
    for (const port of ["vcs", "tracker", "knowledge"] as const) {
      team.integrations[port] = { adapter: "fake" };
    }

    const env = await createAgentEnv({
      team,
      person: "sam",
      registry: createFakeAdapterRegistry(),
      secrets: envSecretSource({}, "/nonexistent"),
      office: createFakeOffice(),
    });

    const r = await ost(["me", "--json"], { ...fakeEnv(), env });
    expect(JSON.parse(r.out).data.connected).toEqual({
      tracker: true,
      knowledge: true,
      vcs: true,
      office: true,
    });

    expect(PortError).toBeTypeOf("function");
  });
});
