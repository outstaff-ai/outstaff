import { describe, expect, it } from "vitest";
import { sampleRunRequest } from "#/contracts/index.js";
import { CAPABILITIES } from "#/capabilities.js";
import type { RuntimeEvent } from "#/ports/index.js";
import {
  createFakeAdapterRegistry,
  createFakeChat,
  createFakeRuntime,
  createFakeTracker,
  createFakeVcs,
} from "#/fakes/index.js";

describe("fake runtime", () => {
  it("judges scripted tool calls with the request policy and records requests", async () => {
    const rt = createFakeRuntime();
    rt.enqueue([
      {
        type: "tool_call",
        tool: "Read",
        call: { kind: "read", path: "/home/agent/scratch/notes.md" },
      },
      {
        type: "tool_call",
        tool: "Write",
        call: { kind: "write", path: "/etc/hosts" },
      },
      { type: "finish", text: "done" },
    ]);

    const req = sampleRunRequest();
    const events: RuntimeEvent[] = [];
    for await (const e of rt.run(req)) {
      events.push(e);
    }

    const decisions = events.flatMap((e) => (e.type === "tool_call" ? [e.decision.effect] : []));
    expect(decisions).toEqual(["allow", "deny"]);
    expect(rt.requests).toEqual([req]);
    expect(events.at(-1)).toMatchObject({ type: "finished", ok: true, text: "done" });
  });
});

describe("fake tracker", () => {
  it("maps canonical statuses to the team's status names", async () => {
    const tracker = createFakeTracker({ statusMap: { review: "In Review" } });
    const issue = await tracker.createIssue({ title: "x", body: "" });
    expect((await tracker.transition(issue.key, "review")).status).toEqual({
      name: "In Review",
      canonical: "review",
    });
  });
});

describe("fake tracker identities", () => {
  it("attributes the calls of a view to its identity and the rest to the default actor", async () => {
    const tracker = createFakeTracker({ actor: { id: "u-1", name: "Dana", kind: "human" } });
    const sam = await tracker.seed.member({ name: "Sam", kind: "agent" });
    const issue = await tracker.as(sam).createIssue({ title: "x", body: "", assignee: sam.id });
    await tracker.as(sam).assign(issue.key, sam.id);
    await tracker.assign(issue.key, sam.id);
    const page = await tracker.events();
    expect(page.events.map((e) => [e.type, e.actor.id])).toEqual([
      ["created", "u-2"],
      ["assigned", "u-2"],
      ["assigned", "u-2"],
      ["assigned", "u-1"],
    ]);
  });
});

describe("fake chat", () => {
  it("splits long posts at line breaks", async () => {
    const chat = createFakeChat({ maxMessageLength: 20 });
    await chat.post("C1", "aaaaaaaaaa\nbbbbbbbbbb\ncccccccccc");
    expect(chat.posts.map((p) => p.text)).toEqual(["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"]);
    expect(new Set(chat.posts.map((p) => p.thread)).size).toBe(1);
  });
});

describe("fake adapter registry", () => {
  it("has a fake for every port and only declares real capabilities", () => {
    const registry = createFakeAdapterRegistry();
    expect(
      registry
        .list()
        .map((d) => d.port)
        .toSorted(),
    ).toEqual(["avatars", "chat", "knowledge", "runtime", "tracker", "vcs"]);

    for (const def of registry.list()) {
      for (const cap of def.capabilities) {
        expect(CAPABILITIES).toContain(cap);
      }
    }
  });
});

describe("fake vcs events", () => {
  const app = { host: "git.acme.example", owner: "acme", name: "app" };
  const libs = { host: "git.acme.example", owner: "acme", name: "libs" };
  const opened = (page: { events: { repo: { name: string }; number: number }[] }) =>
    page.events.map((e) => `${e.repo.name}#${e.number}`);

  it("keeps the place of a repository a poll leaves out", async () => {
    const vcs = createFakeVcs();
    await vcs.seed.pullRequest(app, { title: "a1" });
    await vcs.seed.pullRequest(libs, { title: "l1" });
    const first = await vcs.events([app]);
    expect(opened(first)).toEqual(["app#1"]);

    await vcs.seed.pullRequest(app, { title: "a2" });
    const second = await vcs.events([app, libs], first.cursor);
    expect(opened(second)).toEqual(["libs#1", "app#2"]);

    // Everyone is caught up: the cursor is a plain count again.
    expect(second.cursor).toBe("3");
    expect((await vcs.events([app, libs], second.cursor)).events).toEqual([]);
  });

  it("rejects a cursor it did not make", async () => {
    await expect(createFakeVcs().events([app], "{nope")).rejects.toMatchObject({
      code: "invalid",
    });
  });
});
