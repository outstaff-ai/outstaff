import type { TeamConfig, WorkflowEvent } from "@outstaff/core";
import { afterEach, describe, expect, it } from "vitest";
import { teamConfig } from "../intake/test-support.js";
import { readFeedback } from "./feedback.js";
import { harness, type Harness } from "./test-support.js";

// The office moves a ticket to active when work on it starts, and one ticket gets one round of ticket work.

const dana = { kind: "human", id: "dana" } as const;

const team = (policies: Record<string, unknown> = {}, preset?: string): TeamConfig =>
  teamConfig({
    humans: [{ name: "Dana", identities: { vcs: "dana", tracker: "dana", chat: "U-dana" } }],
    policies,
    ...(preset ? { workflow: { preset } } : {}),
  });

let h: Harness;
afterEach(() => h.close());

const assigned = (key: string): WorkflowEvent => ({
  type: "ticket.assigned",
  subject: { ticket: key },
  actor: dana,
  data: {},
});

const commented = (key: string, body: string, n: number): WorkflowEvent => ({
  type: "ticket.commented",
  subject: { ticket: key },
  actor: dana,
  data: { body, commentId: `cm-${n}` },
});

async function ticket(status: "backlog" | "ready" | "active" | "review" | "blocked" = "ready") {
  const issue = await h.tracker.createIssue({
    title: "Search",
    body: "",
    status,
    assignee: "u-sam",
  });

  await h.ws.apply(
    { type: "ticket.created", subject: { ticket: issue.key }, actor: dana, data: {} },
    { source: "tracker", externalId: `c-${issue.key}`, trusted: true },
  );

  return issue.key;
}

const status = async (key: string) => (await h.tracker.getIssue(key)).status.canonical;
const queue = async () => (await h.items("sam")).filter((i) => i.status === "queued");

async function startItem(key: string, kind: string) {
  const item = await h.scheduler.enqueue({
    person: "sam",
    kind,
    title: kind,
    trigger: "human",
    priority: 50,
    subject: { type: "ticket", ref: key },
  });

  await h.scheduler.markActive(item.id);
  await h.engine.started(item.id);
  return item;
}

describe("a work item that starts", () => {
  it.each(["backlog", "ready", "review", "blocked"] as const)(
    "moves an assigned ticket from %s to active",
    async (from) => {
      h = await harness({ team: team() });
      const key = await ticket(from);
      await startItem(key, "assigned");
      expect(await status(key)).toBe("active");
      expect(h.ws.ticket(key)?.status).toBe("active");
    },
  );

  it("leaves an active ticket alone", async () => {
    h = await harness({ team: team() });
    const key = await ticket("active");
    await startItem(key, "assigned");
    expect(await status(key)).toBe("active");
  });

  it("does not move the ticket for an asked item", async () => {
    h = await harness({ team: team() });
    const key = await ticket("ready");
    await startItem(key, "asked");
    expect(await status(key)).toBe("ready");
  });

  it("does not move the ticket for a document feedback item", async () => {
    h = await harness({ team: team() });
    const key = await ticket("review");
    await startItem(key, "doc_feedback");
    expect(await status(key)).toBe("review");
  });

  it("does not move a ticket for work that is not about a ticket", async () => {
    h = await harness({ team: team() });
    const key = await ticket("ready");
    const chat = await h.scheduler.enqueue({
      person: "sam",
      kind: "chat",
      title: "Chat",
      trigger: "human",
      priority: 50,
      subject: { type: "chat", ref: key },
    });

    await h.scheduler.markActive(chat.id);
    await h.engine.started(chat.id);
    expect(await status(key)).toBe("ready");
  });

  it("policies.tickets.start_moves_active: false leaves the ticket where it is", async () => {
    h = await harness({ team: team({ tickets: { start_moves_active: false } }) });
    const key = await ticket("ready");
    await startItem(key, "assigned");
    expect(await status(key)).toBe("ready");
  });

  it("never moves a ticket under the minimal preset", async () => {
    h = await harness({ team: team({}, "minimal") });
    const key = await ticket("ready");
    await startItem(key, "assigned");
    expect(await status(key)).toBe("ready");
  });
});

describe("one round per ticket", () => {
  it("a comment and an assignment in one poll give one item carrying the comment", async () => {
    h = await harness({ team: team() });
    const key = await ticket("ready");
    await h.deliver(commented(key, "Please start with mobile", 1));
    await h.deliver(assigned(key));

    const items = await queue();
    expect(items).toHaveLength(1);
    expect((await readFeedback(h.store, items[0]!.id)).map((f) => f.body)).toEqual([
      "Please start with mobile",
    ]);
  });

  it("a comment after the assignment joins the assigned item", async () => {
    h = await harness({ team: team() });
    const key = await ticket("ready");
    await h.deliver(assigned(key));
    await h.deliver(commented(key, "Please start with mobile", 1));

    const items = await queue();
    expect(items.map((i) => i.kind)).toEqual(["assigned"]);
    expect((await readFeedback(h.store, items[0]!.id)).map((f) => f.body)).toEqual([
      "Please start with mobile",
    ]);
  });

  it("an assignment during a running ticket_comment round attaches without a second round", async () => {
    h = await harness({ team: team() });
    const key = await ticket("ready");
    const running = await startItem(key, "ticket_comment");
    await h.deliver(assigned(key));

    expect(await queue()).toEqual([]);
    expect((await h.items("sam")).map((i) => i.id)).toEqual([running.id]);
    await h.engine.followUp(running.id);
    expect(await queue()).toEqual([]);
  });

  it("a comment during a running assigned round gets one follow-up after the hand-back", async () => {
    h = await harness({ team: team() });
    const key = await ticket("ready");
    const running = await startItem(key, "assigned");
    await h.deliver(commented(key, "One more thing", 1));
    expect(await queue()).toEqual([]);

    await h.engine.followUp(running.id);
    const [next] = await queue();
    expect(next).toMatchObject({ kind: "assigned", parentId: running.id });
    expect((await readFeedback(h.store, next!.id)).map((f) => f.body)).toEqual(["One more thing"]);
  });
});
