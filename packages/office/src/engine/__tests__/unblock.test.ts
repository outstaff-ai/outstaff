import type { TeamConfig, WorkflowEvent } from "@outstaff/core";
import { afterEach, describe, expect, it } from "vitest";
import { teamConfig } from "#/intake/test-support.js";
import { readFeedback } from "#/engine/feedback.js";
import { harness, type Harness } from "./test-support.js";

// A blocked hand-back goes to the PM as an unblock round, or to nobody in the office: the blocked agent tells the
// requester itself. The office posts nothing to people.

const dana = { kind: "human", id: "dana" } as const;
const people = [
  {
    handle: "sam",
    name: "Sam",
    role: "developer",
    identities: { vcs: "acme-sam[bot]", tracker: "u-sam" },
  },
  { handle: "pat", name: "Pat", role: "pm", identities: { tracker: "u-pat" } },
];

const team = (policies: Record<string, unknown> = {}, withPm = true): TeamConfig =>
  teamConfig({
    humans: [{ name: "Dana", identities: { vcs: "dana", tracker: "dana", chat: "U-dana" } }],
    people: withPm ? people : people.slice(0, 1),
    policies,
  });

let h: Harness;
afterEach(() => h.close());

/** A ticket Dana asked for, which Sam worked on and commented on. */
async function blockedTicket() {
  await h.human("Dana");
  const issue = await h.tracker.createIssue({
    title: "Search",
    body: "",
    status: "active",
    assignee: "u-sam",
  });

  await h.ws.apply(
    { type: "ticket.created", subject: { ticket: issue.key }, actor: dana, data: {} },
    { source: "tracker", externalId: `c-${issue.key}`, trusted: true },
  );

  await h.tracker.comment(issue.key, "Progress: the index is built.");
  const last = await h.tracker.comment(issue.key, "Blocked: I need the staging key from ops.");
  const item = await h.scheduler.enqueue({
    person: "sam",
    kind: "assigned",
    title: "Search",
    trigger: "human",
    subject: { type: "ticket", ref: issue.key },
  });

  await h.scheduler.markActive(item.id);
  return { key: issue.key, item, last };
}

const handedBack = (ticket: string, item: string, actor = "sam"): WorkflowEvent => ({
  type: "agent.handed_back",
  subject: { ticket },
  actor: { kind: "agent", id: actor },
  data: { workItem: item, kind: "assigned", status: "blocked" },
});

const handle = (event: WorkflowEvent) =>
  h.engine.handle(event, { source: "workstate", externalId: `hb-${Math.random()}`, trusted: true });

describe("a blocked hand-back", () => {
  it("with a PM schedules an unblock round for the PM with the ticket, the agent and its last comment", async () => {
    h = await harness({ team: team() });
    const { key, item, last } = await blockedTicket();
    const out = await handle(handedBack(key, item.id));
    expect(out.map((o) => [o.effect.type, o.status])).toEqual([
      ["move", "applied"],
      ["assign", "applied"],
      ["schedule", "applied"],
    ]);

    expect((await h.tracker.getIssue(key)).status.canonical).toBe("blocked");
    const [round] = await h.items("pat");
    expect(round).toMatchObject({
      kind: "unblock",
      status: "queued",
      subject: { type: "ticket", ref: key },
    });

    expect(await readFeedback(h.store, round!.id)).toEqual([
      {
        actor: "sam",
        kind: "blocked",
        body: "Blocked: I need the staging key from ops.",
        url: last.url,
        at: expect.any(String),
      },
    ]);
  });

  it("falls back to the agent's journal when the ticket has no comment", async () => {
    h = await harness({ team: team() });
    const key = (await blockedTicket()).key;
    const bare = await h.tracker.createIssue({ title: "Bare", body: "", assignee: "u-sam" });
    await h.ws.apply(
      { type: "ticket.created", subject: { ticket: bare.key }, actor: dana, data: {} },
      { source: "tracker", externalId: "c-bare", trusted: true },
    );

    const item = await h.scheduler.enqueue({
      person: "sam",
      kind: "assigned",
      title: "Bare",
      trigger: "human",
      subject: { type: "ticket", ref: bare.key },
    });

    await h.store.appendJournal(item.id, "sam", "Waiting on ops for the key.");
    await handle(handedBack(bare.key, item.id));
    const rounds = (await h.items("pat")).filter((i) => i.subject?.ref === bare.key);
    expect((await readFeedback(h.store, rounds[0]!.id))[0]).toMatchObject({
      kind: "blocked",
      body: "Waiting on ops for the key.",
    });

    expect(key).toBeTruthy();
  });

  it("does not move the ticket or reach the blocked agent when the PM's round starts", async () => {
    h = await harness({ team: team() });
    const { key, item } = await blockedTicket();
    await handle(handedBack(key, item.id));
    const [round] = await h.items("pat");
    await h.engine.started(round!.id);
    expect((await h.tracker.getIssue(key)).status.canonical).toBe("blocked");
  });

  it("without a PM schedules nothing and the office schedules nothing for a human", async () => {
    h = await harness({ team: team({}, false) });
    const { key, item } = await blockedTicket();
    const out = await handle(handedBack(key, item.id));
    expect(out.map((o) => [o.effect.type, o.status])).toEqual([
      ["move", "applied"],
      ["assign", "applied"],
    ]);

    expect(await h.items()).toHaveLength(1);
  });

  it("with blocked_notify: agent leaves it to the blocked agent even when there is a PM", async () => {
    h = await harness({ team: team({ hand_back: { blocked_notify: "agent" } }) });
    const { key, item } = await blockedTicket();
    const out = await handle(handedBack(key, item.id));
    expect(out.map((o) => o.effect.type)).toEqual(["move", "assign"]);
    expect(await h.items("pat")).toEqual([]);
  });

  it("from the PM itself schedules no round for the PM", async () => {
    h = await harness({ team: team() });
    const { key } = await blockedTicket();
    const item = await h.scheduler.enqueue({
      person: "pat",
      kind: "assigned",
      title: "Plan",
      trigger: "human",
      subject: { type: "ticket", ref: key },
    });

    const out = await handle(handedBack(key, item.id, "pat"));
    expect(out.at(-1)).toMatchObject({ status: "skipped" });
    expect(out.at(-1)!.note).toContain("the blocked agent itself");
    expect(await h.items("pat")).toHaveLength(1);
  });

  it("is given back to the blocked agent when the PM assigns the ticket to it", async () => {
    h = await harness({ team: team() });
    const { key, item } = await blockedTicket();
    await handle(handedBack(key, item.id));
    await h.scheduler.block(item.id, "blocked by the agent");
    // The PM assigns the ticket back to the blocked agent: the tracker has it, and the event reaches the office.
    await h.tracker.assign(key, "u-sam");
    await h.deliver({
      type: "ticket.assigned",
      subject: { ticket: key },
      actor: { kind: "agent", id: "pat" },
      data: {},
    });

    expect((await h.items("sam")).filter((i) => i.status === "queued")).toMatchObject([
      { kind: "assigned", subject: { type: "ticket", ref: key } },
    ]);
  });

  describe("an item the scheduler blocked", () => {
    const blockedBy = async (reason = "failed 3 times: model overloaded") => {
      const { key, item, last } = await blockedTicket();
      await h.scheduler.block(item.id, reason);
      return { key, item: (await h.store.getItem(item.id))!, last };
    };

    it("with a PM schedules an unblock round for the PM with the reason as data", async () => {
      h = await harness({ team: team() });
      const { key, item } = await blockedBy();
      expect(await h.engine.unblock(item, "failed 3 times: model overloaded")).toBe(true);
      const [round] = await h.items("pat");
      expect(round).toMatchObject({ kind: "unblock", subject: { type: "ticket", ref: key } });
      expect(await readFeedback(h.store, round!.id)).toMatchObject([
        { actor: "sam", kind: "blocked", body: "failed 3 times: model overloaded" },
      ]);

      // A second block of the same ticket joins the round that is queued.
      expect(await h.engine.unblock(item, "stale twice")).toBe(true);
      expect(await h.items("pat")).toHaveLength(1);
      expect((await readFeedback(h.store, round!.id)).map((f) => f.body)).toEqual([
        "failed 3 times: model overloaded",
        "stale twice",
      ]);
    });

    it("without a PM, with the switch on agent, or for the PM itself, leaves it to the agent's report", async () => {
      h = await harness({ team: team({}, false) });
      let b = await blockedBy();
      expect(await h.engine.unblock(b.item, "stale twice")).toBe(false);
      expect(await h.items()).toHaveLength(1);
      await h.close();

      h = await harness({ team: team({ hand_back: { blocked_notify: "agent" } }) });
      b = await blockedBy();
      expect(await h.engine.unblock(b.item, "stale twice")).toBe(false);
      expect(await h.items("pat")).toEqual([]);
      await h.close();

      h = await harness({ team: team() });
      const { key } = await blockedTicket();
      const own = await h.scheduler.enqueue({
        person: "pat",
        kind: "assigned",
        title: "Plan",
        trigger: "human",
        subject: { type: "ticket", ref: key },
      });

      await h.scheduler.markActive(own.id);
      await h.scheduler.block(own.id, "stale twice");
      expect(await h.engine.unblock((await h.store.getItem(own.id))!, "stale twice")).toBe(false);
    });
  });
});
