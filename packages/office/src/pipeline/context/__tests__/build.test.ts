import { describe, expect, it } from "vitest";
import {
  buildWakeContext,
  contextLimits,
  cut,
  DEFAULT_CONTEXT_LIMITS,
} from "#/pipeline/context/index.js";
import { chat, graph, pr12, ref, THREAD, ticket41 } from "./fixture.js";

const limits = DEFAULT_CONTEXT_LIMITS;

describe("the wake context builder", () => {
  it("hands a review on a PR started from chat its ticket and the chat thread, each with a link", () => {
    // Sam asked Kofi in chat; it became ACME-41, then PR #12. A reviewer commented on #12.
    const { context, manifest } = buildWakeContext(
      graph({
        refs: [ref({ type: "pr", ref: "acme/app#12", role: "subject", source: "vcs:review-1" })],
        tickets: [ticket41()],
        prs: [pr12()],
        chats: [chat(2)],
        related: [{ via: { type: "ticket", ref: "ACME-41" }, chat: THREAD, itemId: "item-0" }],
      }),
      limits,
    );

    expect(context.prs.map((p) => [p.ref, p.url, p.why.role])).toEqual([
      ["acme/app#12", "https://git.acme.example/acme/app/pull/12", "subject"],
    ]);

    expect(context.tickets).toEqual([
      {
        key: "ACME-41",
        title: "Checkout drops the coupon",
        url: "https://track.acme.example/ACME-41",
        status: "review",
        assignee: "Kofi",
        description: "The coupon is lost when the cart is reloaded.",
        comments: ticket41().comments,
        why: { role: "linked", source: "implemented by acme/app#12" },
      },
    ]);

    expect(context.chats).toEqual([
      {
        channel: "D-SAM",
        thread: "1700000000.1",
        messages: chat(2).messages,
        why: { role: "linked", source: "chat thread of work item item-0" },
      },
    ]);

    expect(manifest.entries.map((e) => [e.type, e.ref, e.why.role, e.shown, e.left])).toEqual([
      ["pr", "acme/app#12", "subject", 1, 0],
      ["ticket", "ACME-41", "linked", 2, 0],
      ["chat_thread", THREAD, "linked", 2, 0],
    ]);
  });

  it("hands a ticket comment the open PR's CI, mergeability, unresolved threads and stack", () => {
    const { context } = buildWakeContext(
      graph({
        refs: [
          ref({ type: "ticket", ref: "ACME-41", role: "trigger", source: "tracker:c-9" }),
          ref({ type: "pr", ref: "acme/app#12", role: "inferred", source: "workstate:implements" }),
        ],
        tickets: [ticket41()],
        prs: [
          pr12({ stackedOn: "acme/app#11" }),
          pr12({ ref: "acme/app#11", number: 11, ticket: undefined, threads: [], ci: "success" }),
          pr12({ ref: "acme/app#13", number: 13, ticket: undefined, stackedOn: "acme/app#12" }),
          pr12({
            ref: "acme/app#14",
            number: 14,
            ticket: undefined,
            stackedOn: "acme/app#12",
            state: "merged",
          }),
        ],
      }),
      limits,
    );

    const [own, base, top] = context.prs;
    expect(own).toMatchObject({
      ref: "acme/app#12",
      ci: "failure",
      failing: ["test"],
      mergeable: "conflicting",
      review: "changes_requested",
      unresolvedThreads: 1,
      threads: [{ path: "src/cart.ts", line: 7, body: "Keep the old name here." }],
      stackedOn: "acme/app#11",
      stackedBy: ["acme/app#13"],
      why: { role: "inferred", source: "workstate:implements" },
    });

    expect(base?.why).toEqual({ role: "linked", source: "acme/app#12 is stacked on it" });
    expect(top?.why).toEqual({ role: "linked", source: "stacked on acme/app#12" });
    expect(context.prs).toHaveLength(3);
    expect(context.tickets[0]?.why.role).toBe("trigger");
  });

  it("hands a chat message naming a ticket that ticket and its PRs", () => {
    const { context } = buildWakeContext(
      graph({
        refs: [
          ref({ type: "chat_thread", ref: THREAD, role: "trigger", source: "chat:D-SAM:1" }),
          ref({ type: "chat_message", ref: "D-SAM:1", role: "trigger", source: "chat:D-SAM:1" }),
          ref({ type: "ticket", ref: "ACME-41", role: "mentioned", source: "chat:D-SAM:1" }),
        ],
        tickets: [ticket41()],
        prs: [pr12()],
        chats: [chat(1)],
      }),
      limits,
    );

    expect(context.chats.map((c) => c.why.role)).toEqual(["trigger"]);
    expect(context.tickets.map((t) => [t.key, t.why.role])).toEqual([["ACME-41", "mentioned"]]);
    expect(context.prs.map((p) => [p.ref, p.why.source])).toEqual([
      ["acme/app#12", "implements ACME-41"],
    ]);
  });

  it("keeps the latest comments, threads and messages, cuts long text, and caps the items", () => {
    const long = "x".repeat(300);
    const { context, manifest } = buildWakeContext(
      graph({
        refs: [
          ref({ type: "doc", ref: "doc-1", role: "created", source: "doc_link" }),
          ref({ type: "chat_thread", ref: THREAD, role: "trigger", source: "chat:1" }),
          ref({ type: "pr", ref: "acme/app#12", role: "attached", source: "work_attach" }),
          ref({ type: "ticket", ref: "ACME-41", role: "mentioned", source: "chat:1" }),
        ],
        tickets: [
          ticket41({ description: long }),
          {
            key: "ACME-9",
            title: "Old",
            url: undefined,
            comments: [],
            description: "  ",
          },
        ],
        prs: [pr12({ threads: [pr12().threads[0]!, pr12().threads[0]!], unresolvedThreads: 2 })],
        docs: [
          { id: "doc-1", title: "Design", url: "https://kb.acme.example/doc-1", ticket: "ACME-9" },
        ],
        chats: [chat(4)],
      }),
      { ...limits, comments: 1, messages: 2, threads: 1, items: 4, bodyChars: 100 },
    );

    expect(context.chats[0]).toMatchObject({ moreMessages: 2 });
    expect(context.chats[0]!.messages.map((m) => m.text)).toEqual(["message 3", "message 4"]);
    expect(context.prs[0]!.threads).toHaveLength(1);
    expect(context.tickets.map((t) => t.key)).toEqual(["ACME-41"]);
    expect(context.tickets[0]).toMatchObject({ moreComments: 1, comments: [{ author: "Dana" }] });
    expect(context.tickets[0]!.description).toBe(
      `${"x".repeat(100)} ... (cut; the link has the rest)`,
    );

    expect(context.docs).toEqual([
      {
        id: "doc-1",
        title: "Design",
        url: "https://kb.acme.example/doc-1",
        ticket: "ACME-9",
        why: { role: "created", source: "doc_link", addedAt: "2026-10-01T09:00:00.000Z" },
      },
    ]);

    // Five linked items, the farthest (the document's ticket) left out; the trace says what went in.
    expect(context.omitted).toBe(1);
    expect(manifest.omitted).toBe(1);
    expect(manifest.entries.map((e) => e.type)).toEqual(["chat_thread", "doc", "pr", "ticket"]);
    expect(manifest.entries[2]).toMatchObject({ shown: 1, left: 1 });
  });

  it("leaves out what it has no data for, and what a ticket without a link has not", () => {
    const { context } = buildWakeContext(
      graph({
        refs: [
          ref({ type: "pr", ref: "acme/app#99", role: "subject", source: "office" }),
          ref({ type: "doc", ref: "doc-9", role: "created", source: "doc_link" }),
          ref({
            type: "ticket",
            ref: "ACME-1",
            role: "subject",
            source: "office",
            url: "https://track.acme.example/ACME-1",
          }),
          ref({ type: "chat_thread", ref: "C:9", role: "trigger", source: "chat:9" }),
          ref({ type: "commit", ref: "abc", role: "created", source: "office" }),
        ],
        tickets: [{ key: "ACME-1", title: "Plain", comments: [] }],
        prs: [
          pr12({
            ref: "acme/app#99",
            url: undefined,
            ticket: undefined,
            review: undefined,
            threads: [],
          }),
        ],
        docs: [{ id: "doc-9", title: "Notes" }],
      }),
      { ...limits, comments: 0 },
    );

    expect(context.tickets).toEqual([
      {
        key: "ACME-1",
        title: "Plain",
        url: "https://track.acme.example/ACME-1",
        comments: [],
        why: { role: "subject", source: "office", addedAt: "2026-10-01T09:00:00.000Z" },
      },
    ]);

    expect(context.prs[0]).not.toHaveProperty("url");
    expect(context.prs[0]).not.toHaveProperty("review");
    expect(context.docs[0]).toEqual({
      id: "doc-9",
      title: "Notes",
      why: { role: "created", source: "doc_link", addedAt: "2026-10-01T09:00:00.000Z" },
    });

    expect(context.chats).toEqual([]);
    expect(context).not.toHaveProperty("omitted");
  });

  it("hands nothing over for references it has no data for", () => {
    const { context, manifest } = buildWakeContext(
      graph({
        refs: [
          ref({ type: "ticket", ref: "ACME-2", role: "subject", source: "office" }),
          ref({ type: "pr", ref: "acme/app#2", role: "inferred", source: "workstate:implements" }),
          ref({ type: "doc", ref: "doc-2", role: "created", source: "doc_link" }),
        ],
      }),
      limits,
    );

    expect(context).toEqual({ tickets: [], prs: [], docs: [], chats: [] });
    expect(manifest.entries).toEqual([]);
  });

  it("cuts text only past the limit", () => {
    expect(cut("  short  ", 10)).toBe("short");
    expect(cut("abcdef", 3)).toBe("abc ... (cut; the link has the rest)");
  });

  it("reads the limits from pipeline.context over the defaults", () => {
    expect(contextLimits({})).toEqual(DEFAULT_CONTEXT_LIMITS);
    expect(
      contextLimits({
        pipeline: { context: { comments: 1, messages: 2, threads: 3, items: 4, body_chars: 500 } },
      }),
    ).toEqual({ comments: 1, messages: 2, threads: 3, items: 4, bodyChars: 500 });
  });
});
