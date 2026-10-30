import type { TeamConfig, WorkflowEvent } from "@outstaff/core";
import { afterEach, describe, expect, it } from "vitest";
import { teamConfig } from "#/intake/__tests__/test-support.js";
import { readFeedback } from "#/engine/feedback.js";
import { harness, type Harness } from "./test-support.js";

// A trusted person mentioning an agent on a ticket or document hands it the work. The events here carry the handles
// intake resolved; intake's own mapping is tested with intake.

const dana = { kind: "human", id: "dana" } as const;
const sam = { kind: "agent", id: "sam" } as const;
const office = { kind: "automation", id: "outstaff-office" } as const;

// The fake tracker numbers the members it is seeded with after the one it starts with (u-sam is not among them).
const LENA = "u-2";
const KOFI = "u-3";

const team = (policies: Record<string, unknown> = {}): TeamConfig =>
  teamConfig({
    humans: [{ name: "Dana", identities: { vcs: "dana", tracker: "dana", chat: "U-dana" } }],
    people: [
      {
        handle: "sam",
        name: "Sam",
        role: "developer",
        model: "sonnet",
        identities: { vcs: "acme-sam[bot]", tracker: "u-sam" },
      },
      { handle: "lena", name: "Lena", role: "pm", model: "sonnet", identities: { tracker: LENA } },
      {
        handle: "kofi",
        name: "Kofi",
        role: "architect",
        model: "sonnet",
        identities: { tracker: KOFI },
      },
    ],
    policies,
  });

let h: Harness;

/** The harness, with the members the team's tracker identities name. */
async function start(policies: Record<string, unknown> = {}) {
  h = await harness({ team: team(policies) });
  expect((await h.tracker.seed.member({ name: "Lena", kind: "agent" })).id).toBe(LENA);
  expect((await h.tracker.seed.member({ name: "Kofi", kind: "agent" })).id).toBe(KOFI);
}

afterEach(() => h.close());

const commented = (
  ticket: string,
  mentions: string[],
  actor: WorkflowEvent["actor"] = dana,
  body = "@lena please take a look",
): WorkflowEvent => ({
  type: "ticket.commented",
  subject: { ticket },
  actor,
  data: {
    body,
    commentId: "cm-1",
    url: `https://tracker.acme.example/${ticket}#comment-1`,
    at: "2026-01-01T10:00:00.000Z",
    ...(mentions.length > 0 ? { mentions } : {}),
  },
});

/** A ticket sam worked on and handed back (when `to` is a person), or still has. */
async function ticket(
  status: "backlog" | "active" | "review" | "blocked" | "done",
  to: "sam" | "dana",
) {
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
  await h.scheduler.finish(queued.id, { outcome: "ok", status: "done" });
  await h.ws.refreshWorkers();
  return issue.key;
}

const queued = async (person: string) =>
  (await h.items(person)).filter((i) => i.status === "queued");

describe("a mention on a ticket", () => {
  it("assigns the ticket a person has in review, moves it to active and starts the agent with the comment", async () => {
    await start();
    const key = await ticket("review", "dana");
    await h.deliver(commented(key, ["lena"]));

    const now = await h.tracker.getIssue(key);
    expect(now.status.canonical).toBe("active");
    expect(now.assignee?.id).toBe(LENA);

    const [item] = await queued("lena");
    expect(item).toMatchObject({ kind: "ticket_comment", subject: { type: "ticket", ref: key } });
    expect(await readFeedback(h.store, item!.id)).toEqual([
      {
        actor: "dana",
        kind: "ticket_comment",
        body: "@lena please take a look",
        commentId: "cm-1",
        url: `https://tracker.acme.example/${key}#comment-1`,
        at: "2026-01-01T10:00:00.000Z",
      },
    ]);

    // The last worker is not asked, and the commenter is who the hand-back goes to.
    expect(await queued("sam")).toEqual([]);
    expect(h.ws.requester(key)).toBe("dana");
  });

  it("takes the ticket from the agent who has it", async () => {
    await start();
    const key = await ticket("active", "sam");
    await h.deliver(commented(key, ["lena"]));
    expect((await h.tracker.getIssue(key)).assignee?.id).toBe(LENA);
    expect((await queued("lena")).map((i) => i.kind)).toEqual(["ticket_comment"]);
    expect(await queued("sam")).toEqual([]);
  });

  it("activates a ticket in the backlog", async () => {
    await start();
    const key = await ticket("backlog", "dana");
    await h.deliver(commented(key, ["lena"]));
    expect((await h.tracker.getIssue(key)).status.canonical).toBe("active");
  });

  it("goes to the mentioned agent, not the last worker, on a ticket that would reactivate", async () => {
    await start();
    const key = await ticket("blocked", "dana");
    await h.deliver(commented(key, ["lena"]));
    expect((await h.tracker.getIssue(key)).assignee?.id).toBe(LENA);
    expect((await queued("lena")).map((i) => i.kind)).toEqual(["ticket_comment"]);
    expect(await queued("sam")).toEqual([]);
  });

  it("assigns the first agent mentioned and asks the others without reassigning", async () => {
    await start();
    const key = await ticket("review", "dana");
    await h.deliver(commented(key, ["lena", "kofi"], dana, "@lena and @kofi, thoughts?"));

    expect((await h.tracker.getIssue(key)).assignee?.id).toBe(LENA);
    expect((await queued("lena")).map((i) => i.kind)).toEqual(["ticket_comment"]);
    const [asked] = await queued("kofi");
    expect(asked).toMatchObject({ kind: "asked", subject: { type: "ticket", ref: key } });
    expect((await readFeedback(h.store, asked!.id)).map((f) => f.body)).toEqual([
      "@lena and @kofi, thoughts?",
    ]);
  });

  it("an asked round does not make its agent the last worker of the ticket", async () => {
    await start();
    const key = await ticket("review", "dana");
    await h.deliver(commented(key, ["lena", "kofi"]));
    const [asked] = await queued("kofi");
    await h.scheduler.markActive(asked!.id);
    await h.scheduler.finish(asked!.id, { outcome: "ok", status: "done" });
    await h.ws.refreshWorkers();
    expect(h.ws.lastWorker(key)).toBe("sam");
  });

  it.each([
    ["an agent", sam],
    ["the office", office],
  ] as const)("is not started by %s", async (_name, actor) => {
    await start();
    const key = await ticket("review", "dana");
    await h.deliver(commented(key, ["lena"], actor));
    expect(await queued("lena")).toEqual([]);
    expect((await h.tracker.getIssue(key)).status.canonical).toBe("review");
  });

  it("is not started by a human without trust", async () => {
    await start();
    const key = await ticket("review", "dana");
    const event = commented(key, ["lena"]);
    await h.deliver({ ...event, data: { ...event.data, untrusted: true } }, false);
    expect(await queued("lena")).toEqual([]);
    expect((await h.tracker.getIssue(key)).status.canonical).toBe("review");
  });

  it("leaves a done ticket alone", async () => {
    await start();
    const key = await ticket("done", "dana");
    await h.deliver(commented(key, ["lena"]));
    expect(await queued("lena")).toEqual([]);
    expect((await h.tracker.getIssue(key)).status.canonical).toBe("done");
  });
});

describe("a mention on a document", () => {
  const docCommented = (key: string | undefined, mentions: string[]): WorkflowEvent => ({
    type: "doc.commented",
    subject: { doc: "doc-1", ...(key ? { ticket: key } : {}) },
    actor: dana,
    data: {
      docId: "doc-1",
      title: "Cart design",
      url: "https://docs.acme.example/d/doc-1",
      commentId: "doc-1:c1",
      body: "@lena what do you think?",
      at: "2026-01-01T10:00:00.000Z",
      mentions,
    },
  });

  const link = (key?: string) =>
    h.ws.linkDoc({
      id: "doc-1",
      title: "Cart design",
      url: "https://docs.acme.example/d/doc-1",
      author: "sam",
      ...(key ? { ticket: key } : {}),
    });

  it("starts a doc_feedback round for the mentioned agent and hands it the ticket a person has", async () => {
    await start();
    const key = await ticket("review", "dana");
    await link(key);
    await h.deliver(docCommented(key, ["lena"]));

    const [item] = await queued("lena");
    expect(item).toMatchObject({ kind: "doc_feedback" });
    expect((await readFeedback(h.store, item!.id)).map((f) => f.kind)).toEqual(["doc_comment"]);
    expect((await h.tracker.getIssue(key)).assignee?.id).toBe(LENA);
    // Only the assignment: the ticket keeps its status.
    expect((await h.tracker.getIssue(key)).status.canonical).toBe("review");
    // The author still gets the comment on its document.
    expect((await queued("sam")).map((i) => i.kind)).toEqual(["doc_feedback"]);
  });

  it("does not take a ticket from the agent who has it", async () => {
    await start();
    const key = await ticket("active", "sam");
    await link(key);
    await h.deliver(docCommented(key, ["lena"]));
    expect((await queued("lena")).map((i) => i.kind)).toEqual(["doc_feedback"]);
    expect((await h.tracker.getIssue(key)).assignee?.id).toBe("u-sam");
  });

  it("works for a document with no ticket", async () => {
    await start();
    await link();
    await h.deliver(docCommented(undefined, ["lena"]));
    expect((await queued("lena")).map((i) => i.kind)).toEqual(["doc_feedback"]);
  });
});
