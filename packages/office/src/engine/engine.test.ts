import { PortError } from "@outstaff/core";
import type { PrRef, WorkflowEvent } from "@outstaff/core";
import { afterEach, describe, expect, it } from "vitest";
import { REPO } from "../intake/test-support.js";
import { harness, SAM, type Harness } from "./test-support.js";

const ref = (number: number): PrRef => ({ repo: REPO, number });
const dana = { kind: "human", id: "dana" } as const;

let h: Harness;
afterEach(() => h.close());

/** An active ticket sam works on, with a pull request whose mergeability can be scripted. */
async function conflictSetup(prTitle: (key: string) => string = () => "Search") {
  await h.human("Dana");
  const issue = await h.tracker.createIssue({
    title: "Search",
    body: "",
    status: "review",
    assignee: "u-sam",
  });

  await h.ws.apply(
    { type: "ticket.created", subject: { ticket: issue.key }, actor: dana, data: {} },
    { source: "tracker", externalId: "c", trusted: true },
  );

  const pr = await h.vcs.seed.pullRequest(REPO, {
    title: prTitle(issue.key),
    head: { ref: `sam/${issue.key.toLowerCase()}` },
    author: { login: SAM, kind: "agent" },
  });

  await h.ws.apply(
    { type: "pr.opened", subject: { pr: ref(pr.number) }, actor: dana, data: {} },
    { source: "vcs", externalId: "o", trusted: true },
  );

  const conflicted = (id: string): WorkflowEvent => ({
    type: "pr.conflicted",
    subject: { pr: ref(pr.number), ticket: issue.key },
    actor: { kind: "automation", id: "workstate" },
    data: { sha: id },
  });

  return { key: issue.key, pr, conflicted };
}

describe("engine", () => {
  it("applies a redelivered event once", async () => {
    h = await harness();
    const { key, conflicted } = await conflictSetup();
    const meta = { source: "workstate", externalId: "pr.conflicted:1", trusted: true } as const;

    const first = await h.engine.handle(conflicted("1"), meta);
    expect(first.map((o) => o.status)).toEqual(["applied", "applied", "applied", "applied"]);

    // The state has moved on (ticket is active now); the stored plan still decides.
    const again = await h.engine.handle(conflicted("1"), meta);
    expect(again).toEqual(first);
    expect(await h.tracker.listComments(key)).toHaveLength(1);
    expect(await h.items("sam")).toHaveLength(1);
  });

  it("never starts work for a person from an event the person caused", async () => {
    h = await harness();
    await h.human("Dana");
    const issue = await h.tracker.createIssue({ title: "Search", body: "", assignee: "u-sam" });
    await h.ws.apply(
      { type: "ticket.created", subject: { ticket: issue.key }, actor: dana, data: {} },
      { source: "tracker", externalId: "c", trusted: true },
    );

    const assigned = (actor: WorkflowEvent["actor"]): WorkflowEvent => ({
      type: "ticket.assigned",
      subject: { ticket: issue.key },
      actor,
      data: {},
    });

    const own = await h.engine.handle(assigned({ kind: "agent", id: "sam" }), {
      source: "tracker",
      externalId: "own",
      trusted: true,
    });

    expect(own.at(-1)).toMatchObject({ status: "skipped" });
    expect(own.at(-1)!.note).toContain("caused the event themselves");
    expect(await h.items("sam")).toHaveLength(0);

    const byHuman = await h.engine.handle(assigned(dana), {
      source: "tracker",
      externalId: "human",
      trusted: true,
    });

    expect(byHuman.at(-1)).toMatchObject({ status: "applied" });
    expect(await h.items("sam")).toHaveLength(1);
  });

  it("does not queue a second item while one for the same person, subject and kind is live", async () => {
    h = await harness();
    const { conflicted } = await conflictSetup();
    const a = await h.engine.handle(conflicted("1"), {
      source: "workstate",
      externalId: "a",
      trusted: true,
    });

    const b = await h.engine.handle(conflicted("2"), {
      source: "workstate",
      externalId: "b",
      trusted: true,
    });

    expect(a.at(-1)).toMatchObject({ status: "applied" });
    expect(b.at(-1)).toMatchObject({ status: "skipped" });
    expect(b.at(-1)!.note).toContain("already queued");
    expect(await h.items("sam")).toHaveLength(1);

    // Once the item is finished, a new conflict queues a new one.
    const [item] = await h.items("sam");
    await h.store.updateItem(item!.id, { status: "done" });
    const c = await h.engine.handle(conflicted("3"), {
      source: "workstate",
      externalId: "c",
      trusted: true,
    });

    expect(c.at(-1)).toMatchObject({ status: "applied" });
    const items = await h.items("sam");
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.status === "queued")!.parentId).toBe(item!.id);
  });

  it("does not queue an item for a subject a chat request is already working on", async () => {
    h = await harness();
    const { conflicted } = await conflictSetup();
    await h.engine.handle(conflicted("1"), { source: "workstate", externalId: "a", trusted: true });
    const [first] = await h.items("sam");
    await h.store.updateItem(first!.id, { status: "done" });
    await h.store.enqueue({
      person: "sam",
      kind: "chat",
      title: "Chat: fix the conflict",
      trigger: "human",
      subject: first!.subject!,
    });

    const b = await h.engine.handle(conflicted("2"), {
      source: "workstate",
      externalId: "b",
      trusted: true,
    });

    expect(b.at(-1)).toMatchObject({ status: "skipped" });
    expect(await h.items("sam")).toHaveLength(2);
  });

  it("continues after a transient failure without repeating what was applied", async () => {
    h = await harness();
    const { key, conflicted } = await conflictSetup();
    const real = h.tracker.comment.bind(h.tracker);
    let fail = true;
    h.tracker.comment = async (k, body) => {
      if (fail) {
        fail = false;
        throw new PortError("unavailable", "down");
      }

      return real(k, body);
    };

    const meta = { source: "workstate", externalId: "x", trusted: true } as const;
    await expect(h.engine.handle(conflicted("1"), meta)).rejects.toThrow("down");
    expect(await h.items("sam")).toEqual([]);

    const done = await h.engine.handle(conflicted("1"), meta);
    expect(done.map((o) => o.status)).toEqual(["applied", "applied", "applied", "applied"]);
    expect(await h.tracker.listComments(key)).toHaveLength(1);
    expect(await h.items("sam")).toHaveLength(1);
  });

  it("records a permanent port error and carries on", async () => {
    h = await harness();
    const { conflicted } = await conflictSetup();
    h.tracker.comment = () => Promise.reject(new PortError("forbidden", "no"));
    const out = await h.engine.handle(conflicted("1"), {
      source: "workstate",
      externalId: "f",
      trusted: true,
    });

    expect(out.map((o) => o.status)).toEqual(["applied", "applied", "failed", "applied"]);
    expect(await h.items("sam")).toHaveLength(1);
  });

  it("skips tracker effects without a tracker but still schedules", async () => {
    h = await harness({ noTracker: true });
    const { key, conflicted } = await conflictSetup();
    const out = await h.engine.handle(conflicted("1"), {
      source: "workstate",
      externalId: "n",
      trusted: true,
    });

    expect(out.map((o) => o.status)).toEqual(["skipped", "skipped", "skipped", "applied"]);
    expect(out[0]!.note).toContain("no tracker");
    expect(await h.tracker.listComments(key)).toEqual([]);
    expect(await h.items("sam")).toHaveLength(1);
  });

  it("ignores untrusted events entirely", async () => {
    h = await harness();
    const { key, conflicted } = await conflictSetup();
    const out = await h.engine.handle(conflicted("1"), {
      source: "vcs",
      externalId: "u",
      trusted: false,
    });

    const flagged = await h.engine.handle(
      { ...conflicted("2"), data: { untrusted: true } },
      { source: "vcs", externalId: "u2", trusted: true },
    );

    expect([out, flagged]).toEqual([[], []]);
    expect(await h.tracker.listComments(key)).toEqual([]);
    expect(await h.items()).toEqual([]);
  });

  it("takes the trigger and priority class from the actor", async () => {
    h = await harness();
    const { conflicted } = await conflictSetup();
    await h.engine.handle(conflicted("1"), { source: "workstate", externalId: "p", trusted: true });
    const [item] = await h.items("sam");
    expect(item).toMatchObject({ trigger: "automation", priority: 55 });
    expect(item!.title).toBe("conflict: PR #1 Search (ACME-1)");
  });

  it("adds the ticket key to an item title only when the pull request title lacks it", async () => {
    h = await harness();
    const { conflicted } = await conflictSetup((key) => `feat(search): add search (${key})`);
    await h.engine.handle(conflicted("1"), { source: "workstate", externalId: "p", trusted: true });
    const [item] = await h.items("sam");
    expect(item!.title).toMatch(/^conflict: PR #1 feat\(search\): add search \(ACME-1\)$/);
  });

  describe("notify", () => {
    const rules = {
      rules: [
        {
          id: "tell-requester",
          on: "agent.handed_back",
          do: [
            { notify: { to: "requester", template: "rebase_conflict" } },
            { notify: { to: "channel:eng", template: "rebase_conflict" } },
            { notify: { to: "channel", template: "rebase_conflict" } },
          ],
        },
      ],
    };

    it("posts to the requester's direct channel and to named channels", async () => {
      h = await harness({ workflow: rules });
      const { key, pr } = await conflictSetup();
      await h.ws.apply(
        { type: "pr.opened", subject: { pr: ref(pr.number) }, actor: dana, data: {} },
        { source: "vcs", externalId: "o2", trusted: true },
      );

      const out = await h.engine.handle(
        {
          type: "agent.handed_back",
          subject: { ticket: key, pr: ref(pr.number) },
          actor: { kind: "agent", id: "sam" },
          data: {},
        },
        { source: "tracker", externalId: "hb", trusted: true },
      );

      const notes = out.filter((o) => o.effect.type === "notify");
      expect(notes.map((o) => o.status)).toEqual(["applied", "applied", "skipped"]);
      expect(h.chat.posts.map((p) => p.channel)).toEqual(["D-U-dana", "eng"]);
      expect(notes[2]!.note).toContain("no chat destination");
    });

    it("skips notifications without chat", async () => {
      h = await harness({ workflow: rules, noChat: true });
      const { key } = await conflictSetup();
      const out = await h.engine.handle(
        {
          type: "agent.handed_back",
          subject: { ticket: key },
          actor: { kind: "agent", id: "sam" },
          data: {},
        },
        { source: "tracker", externalId: "hb", trusted: true },
      );

      expect(
        out.filter((o) => o.effect.type === "notify").every((o) => o.status === "skipped"),
      ).toBe(true);
    });
  });
});
