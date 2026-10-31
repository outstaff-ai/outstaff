import { silentLogger, type Logger } from "@outstaff/core";
import { traceSchema } from "@outstaff/protocol";
import { describe, expect, it } from "vitest";
import { present, sourceOf } from "#/link/present.js";
import { event, OPTS, stateOf } from "#/pipeline/__tests__/support.js";
import { evaluatePipeline } from "#/pipeline/evaluate.js";
import { BUILT_IN_POLICIES } from "#/pipeline/policies/index.js";
import type { Trace } from "#/pipeline/trace.types.js";
import { OLD_TRACE } from "./old-trace.js";
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

  const opts = { links, logger: silentLogger };

  it("adds the event's source and links to its ticket, pull request and document", () => {
    const t = trace("vcs:1", "2026-10-05T09:00:00.000Z", { ticket: "ACME-1", pr: 9 });
    t.event.subject.doc = "doc-7";
    expect(present(t, opts)).toMatchObject({
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

    t.results = {
      "vcs:1:p": {
        status: "done",
        queuedAt: "2026-10-05T09:00:01.000Z",
        results: ["Moved ACME-1."],
      },
    };

    const presented = present(t, opts);
    expect(presented.results).toEqual(t.results);
    expect(presented).not.toHaveProperty("context");
    expect(traceSchema.safeParse(presented).success).toBe(true);
  });

  it("links a chat message to itself, and leaves out what it cannot link", () => {
    const msg = trace("chat:m1", "2026-10-05T09:00:00.000Z", { ticket: "ACME-1" });
    msg.event.type = "chat.message";
    msg.event.data = { url: "https://chat.acme.example/m1" };
    expect(present(msg, { links: {}, logger: silentLogger }).urls).toEqual({
      chat: "https://chat.acme.example/m1",
    });

    expect(
      present(
        { ...msg, event: { ...msg.event, type: "ticket.commented" } },
        { links: {}, logger: silentLogger },
      ).urls,
    ).toEqual({});
  });

  it("carries every policy's proposals and the aggregation, in a shape the link's schema reads", () => {
    const e = event("ticket.moved", {
      id: "tracker:9",
      subject: { ticket: "ACME-1" },
      data: { to: "active", toName: "In Progress" },
    });

    const world = {
      tickets: {
        "ACME-1": {
          status: "active" as const,
          lastWorker: "sam",
          assignee: { id: "ada.admin", kind: "human" as const },
        },
      },
    };

    const t = evaluatePipeline(e, stateOf(world), BUILT_IN_POLICIES, OPTS);
    expect(t.aggregation.length).toBeGreaterThan(1);
    const presented = present(t, opts);
    expect(presented.aggregation).toEqual(t.aggregation);
    expect(traceSchema.parse(presented).policies.flatMap((p) => p.proposals)).toHaveLength(2);
  });

  it("gives a trace recorded before the aggregation layer an empty aggregation", () => {
    const old = trace("vcs:2", "2026-10-05T09:00:00.000Z") as Partial<Trace>;
    delete old.aggregation;
    expect(present(old as Trace, opts).aggregation).toEqual([]);
  });

  it("brings a trace an older office recorded, with decisions on each policy, to a shape the link reads", () => {
    const presented = present(OLD_TRACE, opts);
    expect(traceSchema.safeParse(presented).success).toBe(true);
    expect(presented).toMatchObject({
      event: { id: "vcs:acme/app#7:merged", source: "vcs" },
      urls: { pr: "https://github.com/acme-example/shop/pull/7" },
      aggregation: [],
      decisions: [{ type: "drop", reason: "no policy matched" }],
    });

    expect(presented.policies[1]).toEqual({
      policy: "merged_closes_ticket",
      matched: false,
      reason: "ticket status done in [active, review]",
      failed: { ticket_status: ["active", "review"] },
      proposals: [],
    });

    expect(presented).not.toHaveProperty("engine");
  });

  it("keeps a policy's legacy decisions as its proposals only when they read as proposals", () => {
    const drop = { type: "drop", reason: "nothing to do" };
    const wake = { type: "wake", policy: "p", person: "ada", kind: "k", instruction: "Go." };
    const old = {
      ...OLD_TRACE,
      policies: [
        { policy: "a", matched: true, reason: "yes", decisions: [drop] },
        { policy: "b", matched: true, reason: "yes", decisions: [wake] },
      ],
    } as unknown as Trace;

    const presented = present(old, opts);
    expect(traceSchema.safeParse(presented).success).toBe(true);
    expect(presented.policies.map((p) => p.proposals)).toEqual([[drop], []]);
  });

  it("sends a trace it cannot read as its event and links alone, logging it once", () => {
    const debug: string[] = [];
    const logger: Logger = { ...silentLogger, debug: (m) => void debug.push(m) };
    const garbage = {
      ...trace("vcs:3", "2026-10-05T09:00:00.000Z", { pr: 4 }),
      policies: "none",
      decisions: [{ type: "teleport" }],
      aggregation: 5,
    } as unknown as Trace;

    const presented = present(garbage, { links, logger });
    present(garbage, { links, logger });
    expect(traceSchema.safeParse(presented).success).toBe(true);
    expect(presented).toEqual({
      event: { ...garbage.event, source: "vcs" },
      urls: { pr: "https://github.com/acme-example/shop/pull/4" },
      policies: [],
      aggregation: [],
      decisions: [],
    });

    expect(debug).toHaveLength(1);

    const empty = { ...garbage, policies: [null], decisions: undefined } as unknown as Trace;
    expect(present(empty, { links, logger }).policies).toEqual([]);
    expect(debug).toHaveLength(1);
  });
});
