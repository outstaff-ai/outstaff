import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeLinkMessage, encodeLinkMessage } from "../codec.js";
import { renderLinkReference } from "../docs.js";
import { LINK_MESSAGE_META, LINK_METHOD_META } from "../meta.js";
import { linkMessageSchema, requestSchema } from "../schemas.js";
import type { LinkMessage } from "../types.js";

const TRACE = {
  event: {
    id: "workstate:handed_back:w1:r1",
    source: "office",
    type: "agent.handed_back",
    at: "2026-10-05T09:00:00.000Z",
    subject: {
      ticket: "ACME-1",
      pr: { repo: { host: "github.com", owner: "acme-example", name: "shop" }, number: 9 },
    },
    actor: { kind: "agent", id: "sam" },
    data: { status: "done" },
  },
  urls: {
    ticket: "https://tracker.acme.example/issue/ACME-1",
    pr: "https://github.com/acme-example/shop/pull/9",
  },
  policies: [
    { policy: "review_to_author", matched: false, reason: "listens to pr.comment", decisions: [] },
    {
      policy: "hand_back_blocked",
      matched: false,
      reason: "hand-back status done in [blocked]",
      failed: { hand_back_status: ["blocked"] },
      decisions: [],
    },
  ],
  decisions: [
    {
      type: "wake",
      policy: "approval_to_merge_after_feedback",
      person: "sam",
      kind: "merge",
      instruction: "Merge it.",
      feedback: [{ actor: "ada-admin", kind: "comment", body: "ok" }],
      subject: { type: "pr", ref: "acme-example/shop#9" },
      itemId: "item-1",
    },
    {
      type: "act",
      policy: "hand_back_done",
      as: "sam",
      ops: [{ op: "move", ticket: "ACME-1", to: "review" }],
      note: "Moved to review for sam.",
    },
    { type: "drop", reason: "no policy matched" },
  ],
  results: {
    "workstate:handed_back:w1:r1:hand_back_done": { ok: true, results: ["moved ACME-1 to review"] },
  },
  engine: {
    effects: [{ type: "move", ticket: "ACME-1", to: "review", as: "office" }],
    skipped: [
      { outcome: { type: "wake", person: "priya", kind: "unblock" }, note: "priya caused it" },
    ],
  },
  comparison: {
    agree: true,
    differences: [
      {
        kind: "actor_changed",
        engine: { type: "move", ticket: "ACME-1", to: "review", as: "office" },
        pipeline: {
          type: "move",
          ticket: "ACME-1",
          to: "review",
          as: "sam",
          policy: "hand_back_done",
        },
        policy: "hand_back_done",
        note: "attributed to sam, not the office",
      },
    ],
  },
};

const ITEM = {
  id: "item-1",
  kind: "merge",
  title: "merge: PR #9",
  subject: { type: "pr", ref: "github.com/acme-example/shop#9" },
  person: "sam",
  status: "active",
  priority: 5,
  trigger: "agent",
  createdAt: "2026-10-05T09:00:00.000Z",
  updatedAt: "2026-10-05T09:01:00.000Z",
  scheduledBy: {
    policy: "approval_to_merge_after_feedback",
    eventId: "workstate:handed_back:w1:r1",
  },
  runs: [{ startedAt: "2026-10-05T09:00:30.000Z", finishedAt: null, outcome: null, error: null }],
  journal: {
    entries: 1,
    latest: [{ at: "2026-10-05T09:00:00.000Z", author: "office", text: "Merge it." }],
  },
};

describe("the office link messages", () => {
  it("round-trip through the codec: requests, responses and notifications", () => {
    const messages = [
      { type: "welcome", payload: { version: 1, office: { id: "acme", name: "Acme" } } },
      {
        type: "hello",
        payload: { office: { team: "acme", version: "1.2.3", pipelineMode: "live" } },
      },
      {
        type: "request",
        payload: {
          id: "r7",
          method: "items",
          params: {
            status: "blocked",
            person: "sam",
            before: "2026-10-05T09:00:00.000Z",
            limit: 10,
          },
        },
      },
      {
        type: "response",
        payload: {
          id: "r7",
          result: {
            items: [
              {
                id: "item-2",
                kind: "assigned",
                title: "assigned: ACME-2",
                subject: { type: "ticket", ref: "ACME-2" },
                person: "sam",
                status: "blocked",
                priority: 50,
                trigger: "human",
                createdAt: "2026-10-05T08:00:00.000Z",
                updatedAt: "2026-10-05T08:30:00.000Z",
                scheduledBy: null,
              },
            ],
            nextBefore: "2026-10-05T08:00:00.000Z",
          },
        },
      },
      { type: "request", payload: { id: "r1", method: "people" } },
      {
        type: "request",
        payload: {
          id: "r2",
          method: "events",
          params: {
            before: "2026-10-05T10:00:00.000Z",
            limit: 20,
            person: "sam",
            ticket: "ACME-1",
            pr: "acme-example/shop#9",
            source: "vcs",
          },
        },
      },
      { type: "request", payload: { id: "r3", method: "event", params: { id: "vcs:1" } } },
      {
        type: "request",
        payload: { id: "r5", method: "compare", params: { since: "2026-10-05T00:00:00.000Z" } },
      },
      { type: "request", payload: { id: "r6", method: "events", params: { differs: true } } },
      {
        type: "response",
        payload: {
          id: "r5",
          result: {
            since: "2026-10-05T00:00:00.000Z",
            events: 3,
            compared: 2,
            agree: 1,
            differ: 1,
            byKind: { actor_changed: 1, missing_in_pipeline: 1 },
            byPolicy: { hand_back_done: 1, "(none)": 1 },
            differing: [
              {
                id: "vcs:1",
                type: "pr.conflicted",
                at: "2026-10-05T09:00:00.000Z",
                differences: [
                  {
                    kind: "missing_in_pipeline",
                    engine: { type: "comment", on: "ACME-1", as: "office" },
                  },
                ],
              },
            ],
          },
        },
      },
      { type: "request", payload: { id: "r4", method: "item", params: { id: "item-1" } } },
      {
        type: "response",
        payload: { id: "r2", result: { events: [TRACE], nextBefore: "2026-10-05T09:00:00.000Z" } },
      },
      { type: "response", payload: { id: "r4", result: { item: ITEM, traces: [TRACE] } } },
      {
        type: "response",
        payload: { id: "r9", error: { code: "unknown_method", message: "No method nope." } },
      },
      {
        type: "people",
        payload: {
          at: "2026-10-05T10:00:00.000Z",
          people: [
            {
              handle: "sam",
              name: "Sam Duarte",
              role: "developer",
              connected: true,
              counts: { queued: 1, running: 0 },
              current: null,
              queue: [
                {
                  id: "item-3",
                  kind: "assigned",
                  title: "assigned: ACME-3",
                  subject: null,
                  priority: 10,
                  trigger: "human",
                  reason: "human: assigned",
                  scheduledBy: null,
                },
              ],
            },
          ],
        },
      },
      { type: "trace", payload: { recordedAt: "2026-10-05T09:00:01.000Z", trace: TRACE } },
      {
        type: "item",
        payload: {
          id: "item-1",
          person: "sam",
          kind: "merge",
          status: "done",
          updatedAt: "2026-10-05T09:05:00.000Z",
        },
      },
      { type: "ping", payload: {} },
      { type: "pong", payload: {} },
    ] as LinkMessage[];

    for (const m of messages) {
      expect(decodeLinkMessage(encodeLinkMessage(m))).toEqual({ ok: true, message: m });
    }
  });

  it("says what is wrong with a frame, and keeps a request's id so it can be answered", () => {
    expect(decodeLinkMessage("not json")).toEqual({
      ok: false,
      problem: "The frame is not valid JSON.",
    });

    expect(decodeLinkMessage("null")).toMatchObject({ ok: false });
    expect(
      decodeLinkMessage('{"type":"request","payload":{"id":"r1","method":"nope"}}'),
    ).toMatchObject({
      ok: false,
      id: "r1",
    });

    const bad = decodeLinkMessage(
      '{"type":"request","payload":{"id":"r2","method":"events","params":{"limit":0}}}',
    );

    expect(bad).toMatchObject({ ok: false, id: "r2", problem: expect.stringContaining("limit") });
  });

  it("describes every message and method, and the committed reference page is current (run `pnpm --filter @outstaff/protocol run docs:protocol`)", () => {
    expect(Object.keys(LINK_MESSAGE_META).toSorted()).toEqual(
      linkMessageSchema.options.map((o) => o.shape.type.value).toSorted(),
    );

    expect(Object.keys(LINK_METHOD_META).toSorted()).toEqual(
      requestSchema.options.map((o) => o.shape.method.value).toSorted(),
    );

    const committed = readFileSync(
      new URL("../../../../../docs/src/content/docs/reference/office-link.md", import.meta.url),
      "utf8",
    );

    expect(committed).toBe(renderLinkReference());
  });
});
