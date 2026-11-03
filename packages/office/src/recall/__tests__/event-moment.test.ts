import type { PrRef, WorkflowEvent } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { eventMoment } from "#/recall/index.js";

const REPO = { host: "git.acme.example", owner: "acme", name: "app" };
const prKey = (pr: PrRef) => `${pr.repo.host}/${pr.repo.owner}/${pr.repo.name}#${pr.number}`;
const AT = "2026-10-01T10:00:00.000Z";

const event = (over: Partial<WorkflowEvent>): WorkflowEvent => ({
  type: "ticket.commented",
  subject: { ticket: "ACME-1" },
  actor: { kind: "human", id: "ada.admin" },
  data: {},
  ...over,
});

const moment = (over: Partial<WorkflowEvent>) => eventMoment(event(over), "tracker:1", AT, prKey);

describe("an event as a moment", () => {
  it("keeps a comment's text, author, link and time, seen by every agent on the ticket", () => {
    expect(
      moment({
        data: { body: "Keep it short.", url: "https://t/1#c", at: "2026-10-01T09:00:00.000Z" },
      }),
    ).toEqual({
      key: "event:tracker:1",
      person: null,
      at: "2026-10-01T09:00:00.000Z",
      kind: "ticket.commented",
      subject: { type: "ticket", ref: "ACME-1" },
      actor: "ada.admin",
      actorName: null,
      text: "Keep it short.",
      url: "https://t/1#c",
    });
  });

  it("says what was done for moves, reviews, merges, closes and new tickets", () => {
    const text = (over: Partial<WorkflowEvent>) => moment(over)?.text;
    expect(text({ type: "ticket.moved", data: { from: "ready", to: "review" } })).toBe(
      "moved from ready to review",
    );

    expect(text({ type: "ticket.moved", data: {} })).toBe("moved");
    expect(text({ type: "ticket.closed", data: { status: "done" } })).toBe("closed as done");
    expect(text({ type: "ticket.closed", data: {} })).toBe("closed");
    expect(text({ type: "ticket.assigned" })).toBe("assigned");
    expect(text({ type: "ticket.created", data: { title: "Greet", body: "On the page." } })).toBe(
      "created: Greet: On the page.",
    );

    const pr = { subject: { pr: { repo: REPO, number: 12 } } };
    expect(text({ ...pr, type: "pr.opened", data: { title: "Greetings" } })).toBe(
      "opened: Greetings",
    );

    expect(text({ ...pr, type: "pr.merged" })).toBe("merged");
    expect(text({ ...pr, type: "pr.closed" })).toBe("closed");
    expect(
      text({ ...pr, type: "pr.review_submitted", data: { state: "changes_requested", body: "x" } }),
    ).toBe("review: changes requested: x");

    expect(text({ ...pr, type: "pr.review_submitted" })).toBe("review: commented");
    expect(moment({ ...pr, type: "pr.merged" })?.subject).toEqual({
      type: "pr",
      ref: "git.acme.example/acme/app#12",
    });
  });

  it("puts a comment on a document on the document", () => {
    expect(
      moment({
        type: "doc.commented",
        subject: { doc: "d7", ticket: "ACME-1" },
        data: { body: "Hm" },
      })?.subject,
    ).toEqual({ type: "doc", ref: "d7" });
  });

  it("gives a chat message to the agent it was written to, in its thread", () => {
    const chat = (data: Record<string, unknown>) =>
      moment({
        type: "chat.message",
        subject: { chat: { channel: "D1" } },
        actor: { kind: "human", id: "U1" },
        data,
      });

    const message = { channel: "D1", messageId: "100.1", author: { id: "U1", name: "Ada" } };
    expect(chat({ body: "Hi", addressed: "sam", message })).toMatchObject({
      person: "sam",
      subject: { type: "chat_thread", ref: "D1:100.1" },
      actorName: "Ada",
      at: AT,
    });

    expect(
      chat({ body: "Hi", addressed: "sam", message: { ...message, thread: "99.1" } })?.subject,
    ).toEqual({ type: "chat_thread", ref: "D1:99.1" });

    expect(chat({ body: "Hi", addressed: "sam" })?.subject).toEqual({
      type: "chat_thread",
      ref: "D1",
    });

    // Never anyone's but its addressee's: without one it is not recalled at all.
    expect(chat({ body: "Hi", message })).toBeUndefined();
  });

  it("leaves out events that say nothing, and the office's own", () => {
    expect(moment({ data: { body: "  " } })).toBeUndefined();
    expect(moment({ type: "pr.ci_failed" })).toBeUndefined();
    expect(moment({ type: "agent.handed_back", data: { summary: "x" } })).toBeUndefined();
    expect(moment({ subject: {}, data: { body: "x" } })?.subject).toBeNull();
  });
});
