import { traceSchema } from "@outstaff/protocol";
import { describe, expect, it } from "vitest";
import { present, sourceOf } from "#/link/present.js";
import { trace } from "./support.js";

describe("sourceOf", () => {
  it("names where an event came from by its id", () => {
    expect(
      ["vcs:1", "tracker:1", "knowledge:1", "chat:1", "workstate:x", "derived:y", "replay:z"].map(
        sourceOf,
      ),
    ).toEqual(["vcs", "tracker", "knowledge", "chat", "office", "office", "office"]);
  });
});

describe("present", () => {
  const links = {
    ticket: (key: string) => `https://tracker.acme.example/issue/${key}`,
    pr: (pr: { number: number }) => `https://github.com/acme-example/shop/pull/${pr.number}`,
    doc: (id: string) => `https://docs.acme.example/${id}`,
  };

  it("adds the event's source and links to its ticket, pull request and document", () => {
    const t = trace("vcs:1", "2026-10-05T09:00:00.000Z", { ticket: "ACME-1", pr: 9 });
    t.event.subject.doc = "doc-7";
    expect(present(t, links)).toMatchObject({
      event: { id: "vcs:1", source: "vcs" },
      urls: {
        ticket: "https://tracker.acme.example/issue/ACME-1",
        pr: "https://github.com/acme-example/shop/pull/9",
        doc: "https://docs.acme.example/doc-7",
      },
    });
  });

  it("leaves out what only the office keeps, so the link's schema reads it", () => {
    const t = trace("vcs:1", "2026-10-05T09:00:00.000Z", { ticket: "ACME-1", wake: "dev" });
    t.context = {
      "item-1": {
        itemId: "item-1",
        entries: [{ type: "ticket", ref: "ACME-1", why: { role: "trigger", source: "event" } }],
        omitted: 0,
        limits: { comments: 10, messages: 20, threads: 10, items: 8, bodyChars: 4000 },
      },
    };

    const presented = present(t, links);
    expect(presented).not.toHaveProperty("context");
    expect(traceSchema.safeParse(presented).success).toBe(true);
  });

  it("links a chat message to itself, and leaves out what it cannot link", () => {
    const msg = trace("chat:m1", "2026-10-05T09:00:00.000Z", { ticket: "ACME-1" });
    msg.event.type = "chat.message";
    msg.event.data = { url: "https://chat.acme.example/m1" };
    expect(present(msg, {}).urls).toEqual({ chat: "https://chat.acme.example/m1" });
    expect(present({ ...msg, event: { ...msg.event, type: "ticket.commented" } }, {}).urls).toEqual(
      {},
    );
  });
});
