import type { TeamConfig, WorkflowEvent } from "@outstaff/core";
import { afterEach, describe, expect, it } from "vitest";
import { teamConfig } from "#/intake/test-support.js";
import { readFeedback } from "#/engine/feedback.js";
import { harness, type Harness } from "./test-support.js";

// Comments on tickets and on documents reach the agent: preset rules, the engine and the feedback they carry.

const dana = { kind: "human", id: "dana" } as const;
const sam = { kind: "agent", id: "sam" } as const;
const office = { kind: "automation", id: "outstaff-office" } as const;

const team = (policies: Record<string, unknown> = {}): TeamConfig =>
  teamConfig({
    humans: [{ name: "Dana", identities: { vcs: "dana", tracker: "dana", chat: "U-dana" } }],
    policies,
  });

let h: Harness;
afterEach(() => h.close());

const commented = (
  ticket: string,
  actor: WorkflowEvent["actor"] = dana,
  body = "Can you also cover mobile?",
  n = 1,
): WorkflowEvent => ({
  type: "ticket.commented",
  subject: { ticket },
  actor,
  data: { body, commentId: `cm-${n}`, url: `https://tracker.acme.example/${ticket}#comment-${n}` },
});

const docCommented = (
  over: Partial<WorkflowEvent> & { data?: Record<string, unknown> } = {},
): WorkflowEvent => ({
  type: "doc.commented",
  subject: { doc: "doc-1", ticket: "SHOP-1" },
  actor: dana,
  ...over,
  data: {
    docId: "doc-1",
    title: "Cart design",
    url: "https://docs.acme.example/d/doc-1",
    commentId: "doc-1:c1",
    anchorText: "Keep the cart in the session",
    body: "Why not the database?",
    at: "2026-01-01T10:00:00.000Z",
    ...over.data,
  },
});

/** A ticket Sam worked on; `to` is who has it now. */
async function ticket(status: "active" | "review", to: "sam" | "dana") {
  const assignee = to === "sam" ? "u-sam" : (await h.human("Dana")).id;
  const issue = await h.tracker.createIssue({ title: "Search", body: "", status, assignee });
  await h.ws.apply(
    { type: "ticket.created", subject: { ticket: issue.key }, actor: dana, data: {} },
    { source: "tracker", externalId: `c-${issue.key}`, trusted: true },
  );

  const queued = await h.scheduler.enqueue({
    person: "sam",
    kind: "assigned",
    title: "Search",
    trigger: "human",
    priority: 50,
    subject: { type: "ticket", ref: issue.key },
  });

  await h.scheduler.markActive(queued.id);
  await h.ws.refreshWorkers();
  return issue.key;
}

const kinds = async () => (await h.items("sam")).filter((i) => i.status === "queued");

describe("a comment on a ticket", () => {
  it("starts a round for the assigned agent, carrying the comment as feedback", async () => {
    h = await harness({ team: team() });
    const key = await ticket("active", "sam");
    await h.scheduler.finish((await h.items("sam"))[0]!.id, { outcome: "ok", status: "done" });
    await h.deliver(commented(key));

    const [item] = await kinds();
    expect(item).toMatchObject({ kind: "ticket_comment", subject: { type: "ticket", ref: key } });
    expect(await readFeedback(h.store, item!.id)).toEqual([
      {
        actor: "dana",
        kind: "ticket_comment",
        body: "Can you also cover mobile?",
        commentId: "cm-1",
        url: `https://tracker.acme.example/${key}#comment-1`,
      },
    ]);
  });

  it("joins the round that is already queued instead of starting a second one", async () => {
    h = await harness({ team: team() });
    const key = await ticket("active", "sam");
    await h.scheduler.finish((await h.items("sam"))[0]!.id, { outcome: "ok", status: "done" });
    await h.deliver(commented(key, dana, "First", 1));
    await h.deliver(commented(key, dana, "Second", 2));

    const items = await kinds();
    expect(items).toHaveLength(1);
    expect((await readFeedback(h.store, items[0]!.id)).map((f) => f.body)).toEqual([
      "First",
      "Second",
    ]);
  });

  it("on a ticket the agent handed back, reactivates it for the agent who last worked on it", async () => {
    h = await harness({ team: team() });
    const key = await ticket("review", "dana");
    await h.scheduler.finish((await h.items("sam"))[0]!.id, { outcome: "ok", status: "done" });
    await h.ws.refreshWorkers();
    await h.deliver(commented(key));

    const now = await h.tracker.getIssue(key);
    expect(now.status.canonical).toBe("active");
    expect(now.assignee?.name).toBe("Sam");
    expect((await kinds()).map((i) => i.kind)).toEqual(["ticket_comment"]);
    // The commenter is who the next hand-back goes to.
    expect(h.ws.requester(key)).toBe("dana");
  });

  it.each([
    ["an agent", sam],
    ["the office", office],
  ] as const)("is not started by %s", async (_name, actor) => {
    h = await harness({ team: team() });
    const key = await ticket("active", "sam");
    await h.scheduler.finish((await h.items("sam"))[0]!.id, { outcome: "ok", status: "done" });
    await h.deliver(commented(key, actor));
    expect(await kinds()).toEqual([]);
  });

  it("is not started by a human without trust", async () => {
    h = await harness({ team: team() });
    const key = await ticket("active", "sam");
    await h.scheduler.finish((await h.items("sam"))[0]!.id, { outcome: "ok", status: "done" });
    await h.deliver(
      { ...commented(key), data: { ...commented(key).data, untrusted: true } },
      false,
    );

    expect(await kinds()).toEqual([]);
  });

  it("policies.feedback.ticket_comments: false switches both rules off", async () => {
    h = await harness({ team: team({ feedback: { ticket_comments: false } }) });
    const key = await ticket("review", "dana");
    await h.scheduler.finish((await h.items("sam"))[0]!.id, { outcome: "ok", status: "done" });
    await h.ws.refreshWorkers();
    await h.deliver(commented(key));
    expect(await kinds()).toEqual([]);
    expect((await h.tracker.getIssue(key)).status.canonical).toBe("review");
  });
});

describe("a comment on a document", () => {
  const doc = (ticketKey?: string) =>
    h.ws.linkDoc({
      id: "doc-1",
      title: "Cart design",
      url: "https://docs.acme.example/d/doc-1",
      author: "sam",
      ...(ticketKey ? { ticket: ticketKey } : {}),
    });

  it("schedules doc_feedback for the author on the document's ticket, with the anchor and link", async () => {
    h = await harness({ team: team() });
    const key = await ticket("review", "dana");
    await h.scheduler.finish((await h.items("sam"))[0]!.id, { outcome: "ok", status: "done" });
    await doc(key);
    await h.deliver(docCommented({ subject: { doc: "doc-1", ticket: key } }));

    const [item] = await kinds();
    expect(item).toMatchObject({ kind: "doc_feedback", subject: { type: "ticket", ref: key } });
    expect(await readFeedback(h.store, item!.id)).toEqual([
      {
        actor: "dana",
        kind: "doc_comment",
        body: "Why not the database?",
        docId: "doc-1",
        anchorText: "Keep the cart in the session",
        commentId: "doc-1:c1",
        url: "https://docs.acme.example/d/doc-1",
        at: "2026-01-01T10:00:00.000Z",
      },
    ]);

    // Answering a comment on a document does not touch its ticket.
    expect((await h.tracker.getIssue(key)).status.canonical).toBe("review");
  });

  it("keeps one round for a burst of comments, oldest first", async () => {
    h = await harness({ team: team() });
    const key = await ticket("review", "dana");
    await h.scheduler.finish((await h.items("sam"))[0]!.id, { outcome: "ok", status: "done" });
    await doc(key);
    const second = docCommented({
      subject: { doc: "doc-1", ticket: key },
      data: { body: "And caching?", commentId: "doc-1:c2", at: "2026-01-01T09:00:00.000Z" },
    });

    await h.deliver(docCommented({ subject: { doc: "doc-1", ticket: key } }));
    await h.deliver(second);
    const items = await kinds();
    expect(items).toHaveLength(1);
    expect((await readFeedback(h.store, items[0]!.id)).map((f) => f.body)).toEqual([
      "And caching?",
      "Why not the database?",
    ]);
  });

  it("works for a document written outside a ticket", async () => {
    h = await harness({ team: team() });
    await doc();
    await h.deliver(docCommented({ subject: { doc: "doc-1" } }));
    const [item] = await kinds();
    expect(item).toMatchObject({
      kind: "doc_feedback",
      subject: { type: "doc", ref: "doc-1" },
      title: expect.stringContaining("Cart design"),
    });
  });

  it.each([
    ["an agent", sam],
    ["the office", office],
  ] as const)("is not started by %s", async (_name, actor) => {
    h = await harness({ team: team() });
    await doc("SHOP-1");
    await h.deliver(docCommented({ actor }));
    expect(await kinds()).toEqual([]);
  });

  it("is not started by a human without trust, nor for a document nobody recorded", async () => {
    h = await harness({ team: team() });
    await doc("SHOP-1");
    await h.deliver(docCommented({ data: { untrusted: true } }), false);
    await h.deliver(docCommented({ subject: { doc: "doc-9" } }));
    expect(await kinds()).toEqual([]);
  });

  it("policies.feedback.doc_comments: false switches the rule off", async () => {
    h = await harness({ team: team({ feedback: { doc_comments: false } }) });
    await doc("SHOP-1");
    await h.deliver(docCommented());
    expect(await kinds()).toEqual([]);
  });
});

describe("the work state's documents", () => {
  it("keeps the first author, lists the most recently active first, and drops those of finished tickets", async () => {
    h = await harness({ team: team() });
    const key = await ticket("review", "dana");
    const link = (id: string, author = "sam", ticketKey?: string) =>
      h.ws.linkDoc({
        id,
        title: id,
        url: `https://docs.acme.example/d/${id}`,
        author,
        ...(ticketKey ? { ticket: ticketKey } : {}),
      });

    await link("a", "sam", key);
    h.clock.advance(60_000);
    await link("b");
    h.clock.advance(60_000);
    await link("a", "noor");
    expect(h.ws.docAuthor("a")).toBe("sam");
    expect(h.ws.openDocs(10).map((d) => d.id)).toEqual(["a", "b"]);
    expect(h.ws.openDocs(1).map((d) => d.id)).toEqual(["a"]);

    await h.tracker.transition(key, "done");
    await h.deliver({
      type: "ticket.moved",
      subject: { ticket: key },
      actor: dana,
      data: { from: "review", to: "done" },
    });

    expect(h.ws.openDocs(10).map((d) => d.id)).toEqual(["b"]);
  });
});
