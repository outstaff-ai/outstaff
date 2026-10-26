import type { StaticTicket } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICIES } from "../defaults.js";
import { describeDecision } from "../describe.js";
import { evaluatePipeline } from "../evaluate.js";
import type { PipelineEvent } from "../events.types.js";
import { event, HUMAN_AUTHOR, OPTS, pr, prRef, stateOf, type World } from "./support.js";

const ADA: PipelineEvent["actor"] = { kind: "human", id: "ada-admin" };
const SAM = { kind: "agent" as const, id: "sam" };
const OFFICE = { kind: "automation" as const, id: "office" };

/** What one default policy makes of an event: its decisions, or the condition that failed. */
function judge(id: string, e: PipelineEvent, world: World = {}) {
  const trace = evaluatePipeline(e, stateOf(world), DEFAULT_POLICIES, OPTS);
  const p = trace.policies.find((t) => t.policy === id)!;
  return p.matched ? p.decisions.map(describeDecision) : { failed: p.failed ?? p.reason };
}

const t = (
  status: StaticTicket["status"],
  assignee?: string,
  extra: Partial<StaticTicket> = {},
) => ({
  status,
  ...(assignee
    ? {
        assignee: {
          id: assignee,
          kind: OPTS.people.includes(assignee) ? ("agent" as const) : ("human" as const),
        },
      }
    : {}),
  ...extra,
});

const onPr = (
  type: PipelineEvent["type"],
  data: Record<string, unknown> = {},
  actor: PipelineEvent["actor"] = ADA,
) => event(type, { subject: { pr: prRef(9) }, actor, data });

const prWorld = (
  o: Parameters<typeof pr>[1] = {},
  status: StaticTicket["status"] = "review",
): World => ({
  prs: [pr(9, o)],
  links: { 9: "ACME-9" },
  tickets: { "ACME-9": t(status, "sam") },
});

describe("default policies", () => {
  it("are listed once each, wakes with an instruction and acts without", () => {
    expect(new Set(DEFAULT_POLICIES.map((p) => p.id)).size).toBe(DEFAULT_POLICIES.length);
    for (const p of DEFAULT_POLICIES) {
      expect({ id: p.id, instruction: p.instruction !== undefined }).toEqual({
        id: p.id,
        instruction: "wake" in p.decide,
      });
    }
  });

  it("chat_to_addressed: a human's message wakes the agent it is written to", () => {
    const msg = (actor = ADA) =>
      event("chat.message", {
        subject: { chat: { channel: "D0SAM" } },
        actor,
        data: { addressed: "sam", body: "hi" },
      });

    expect(judge("chat_to_addressed", msg())).toEqual(["wake sam (chat) on chat D0SAM"]);

    expect(judge("chat_to_addressed", msg(SAM))).toEqual({ failed: { actor_kind: "human" } });
  });

  it("review_to_author: feedback on an agent's open pull request, but not a bare approval", () => {
    expect(
      judge(
        "review_to_author",
        onPr("pr.comment", { kind: "comment", body: "Rename it." }),
        prWorld(),
      ),
    ).toEqual(["wake sam (review_feedback) on pr acme-example/shop#9"]);

    const bare = onPr("pr.review_submitted", { state: "approved", body: "" });
    expect(judge("review_to_author", bare, prWorld())).toMatchObject({ failed: { not: {} } });
    expect(
      judge(
        "review_to_author",
        onPr("pr.comment", { body: "x" }),
        prWorld({ author: HUMAN_AUTHOR }),
      ),
    ).toEqual({
      failed: { pr_author_kind: "agent" },
    });
  });

  it("merged_feedback_to_author: feedback on an agent's merged pull request", () => {
    const e = onPr("pr.review_submitted", { state: "commented", body: "Log the time." });
    expect(judge("merged_feedback_to_author", e, prWorld({ state: "merged" }, "done"))).toEqual([
      "wake sam (merged_feedback) on pr acme-example/shop#9",
    ]);

    expect(judge("merged_feedback_to_author", e, prWorld())).toEqual({
      failed: { pr_merged: true },
    });
  });

  it("approval_to_merge: an allowed approver's bare approval wakes the author to merge", () => {
    const bare = onPr("pr.review_submitted", { state: "approved", body: "" });
    expect(judge("approval_to_merge", bare, prWorld())).toEqual([
      "wake sam (merge) on pr acme-example/shop#9",
    ]);

    const noted = onPr("pr.review_submitted", { state: "approved", body: "One nit." });
    expect(judge("approval_to_merge", noted, prWorld())).toEqual({ failed: { has_body: false } });
  });

  it("approval_to_merge_after_feedback: the author's done round on an approved pull request", () => {
    const back = onPr("agent.handed_back", { status: "done", kind: "review_feedback" }, SAM);
    const verdicts = [{ actor: "ada-admin", kind: "human" as const, state: "approved" as const }];
    expect(judge("approval_to_merge_after_feedback", back, prWorld({ verdicts }))).toEqual([
      "wake sam (merge) on pr acme-example/shop#9",
    ]);

    expect(judge("approval_to_merge_after_feedback", back, prWorld())).toEqual({
      failed: { pr_approved: true },
    });
  });

  it("merged_closes_ticket: as the author, unless the merge was into another branch or another pull request is open", () => {
    const merged = onPr("pr.merged");
    expect(judge("merged_closes_ticket", merged, prWorld({ state: "merged" }))).toEqual([
      "act as sam: move ACME-9 to done",
    ]);

    expect(
      judge("merged_closes_ticket", merged, prWorld({ state: "merged", baseRef: "sam/acme-8" })),
    ).toEqual({
      failed: { pr_base_default: true },
    });

    const two = {
      ...prWorld({ state: "merged" }),
      prs: [pr(9, { state: "merged" }), pr(10)],
      links: { 9: "ACME-9", 10: "ACME-9" },
    };

    expect(judge("merged_closes_ticket", merged, two)).toEqual({
      failed: { not: { ticket_prs_open: true } },
    });

    expect(
      judge("merged_closes_ticket", merged, prWorld({ state: "merged", author: HUMAN_AUTHOR })),
    ).toEqual([
      "drop: no agent to act as (the office never acts as itself): pull request has no agent author",
    ]);
  });

  it("rebase_to_author: conflicts, a base behind or merged, on an agent's open pull request, naming the cause", () => {
    for (const type of ["pr.conflicted", "pr.behind_base", "pr.base_merged"] as const) {
      const e = onPr(type, { cause: { pr: prRef(8), title: "Cart totals" } }, OFFICE);
      expect({ type, decided: judge("rebase_to_author", e, prWorld()) }).toEqual({
        type,
        decided: ["wake sam (rebase) on pr acme-example/shop#9"],
      });
    }

    const trace = evaluatePipeline(
      onPr("pr.behind_base", { cause: { pr: prRef(8), title: "Cart totals" } }, OFFICE),
      stateOf(prWorld()),
      DEFAULT_POLICIES,
      OPTS,
    );

    expect(trace.decisions[0]).toMatchObject({
      instruction:
        "Your pull request #9 (Change 9) is behind its base branch, and the repository requires it to be up to date after #8 (Cart totals) merged. Bring it up to date with `main` the way the repository asks, and push.",
    });

    expect(
      judge("rebase_to_author", onPr("pr.conflicted", {}, OFFICE), prWorld({}, "canceled")),
    ).toEqual({
      failed: { not: { ticket_status: ["canceled"] } },
    });
  });

  it("ci_failed_to_author: failing checks on an agent's open pull request", () => {
    const e = onPr("pr.ci_failed", { checks: [{ name: "test" }] }, OFFICE);
    expect(judge("ci_failed_to_author", e, prWorld())).toEqual([
      "wake sam (ci_failed) on pr acme-example/shop#9",
    ]);

    expect(judge("ci_failed_to_author", e, prWorld({ author: HUMAN_AUTHOR }))).toEqual({
      failed: { pr_author_kind: "agent" },
    });
  });

  it("opened_to_review: a pull request ready for review moves its open ticket, as the author", () => {
    const opened = onPr("pr.opened", {}, SAM);
    expect(judge("opened_to_review", opened, prWorld({}, "active"))).toEqual([
      "act as sam: move ACME-9 to review",
    ]);

    expect(judge("opened_to_review", opened, prWorld({ draft: true }, "active"))).toEqual({
      failed: { not: { pr_draft: true } },
    });

    expect(judge("opened_to_review", opened, prWorld({}, "done"))).toEqual({
      failed: { ticket_status: ["backlog", "ready", "active"] },
    });
  });

  it("assigned_to_assignee: an assignment to an agent by anyone but that agent", () => {
    const world = { tickets: { "ACME-1": t("ready", "sam") } };
    const assigned = (
      actor: PipelineEvent["actor"],
      type: PipelineEvent["type"] = "ticket.assigned",
    ) => event(type, { subject: { ticket: "ACME-1" }, actor });

    expect(judge("assigned_to_assignee", assigned(ADA), world)).toEqual([
      "wake sam (assigned) on ticket ACME-1",
    ]);

    expect(judge("assigned_to_assignee", assigned(ADA, "ticket.created"), world)).toEqual([
      "wake sam (assigned) on ticket ACME-1",
    ]);

    expect(judge("assigned_to_assignee", assigned({ kind: "agent", id: "noor" }), world)).toEqual([
      "wake sam (assigned) on ticket ACME-1",
    ]);

    expect(judge("assigned_to_assignee", assigned(SAM), world)).toEqual({
      failed: { not: { actor_is: "assignee" } },
    });

    expect(judge("assigned_to_assignee", assigned(OFFICE), world)).toEqual({
      failed: { not: { actor_kind: "automation" } },
    });

    expect(
      judge("assigned_to_assignee", assigned(ADA), { tickets: { "ACME-1": t("done", "sam") } }),
    ).toMatchObject({
      failed: { not: {} },
    });
  });

  it("ticket_comment_to_agent: a human's comment wakes the agent mentioned, else the assignee", () => {
    const world = { tickets: { "ACME-1": t("active", "sam") } };
    const comment = (data: Record<string, unknown> = {}, actor = ADA) =>
      event("ticket.commented", {
        subject: { ticket: "ACME-1" },
        actor,
        data: { body: "x", ...data },
      });

    expect(judge("ticket_comment_to_agent", comment(), world)).toEqual([
      "wake sam (ticket_comment) on ticket ACME-1",
    ]);

    expect(judge("ticket_comment_to_agent", comment({ mentions: ["mira"] }), world)).toEqual([
      "wake mira (ticket_comment) on ticket ACME-1",
    ]);

    expect(
      judge("ticket_comment_to_agent", comment(), {
        tickets: { "ACME-1": t("review", "ada.admin") },
      }),
    ).toMatchObject({
      failed: { any: expect.any(Array) },
    });

    expect(judge("ticket_comment_to_agent", comment({}, SAM), world)).toEqual({
      failed: { actor_kind: "human" },
    });
  });

  it("moved_active_to_assignee: a human moving an agent's ticket to active", () => {
    const moved = (to: string) =>
      event("ticket.moved", { subject: { ticket: "ACME-1" }, data: { to } });

    const world = { tickets: { "ACME-1": t("active", "sam") } };
    expect(judge("moved_active_to_assignee", moved("active"), world)).toEqual([
      "wake sam (assigned) on ticket ACME-1",
    ]);

    expect(judge("moved_active_to_assignee", moved("review"), world)).toEqual({
      failed: { moved_to: ["active"] },
    });
  });

  it("doc_comment_to_agent: a human's comment wakes the agent mentioned, else the author", () => {
    const comment = (data: Record<string, unknown> = {}) =>
      event("doc.commented", {
        subject: { doc: "doc-7" },
        data: { title: "Order events", ...data },
      });

    const world = { docs: { "doc-7": "mira" } };
    expect(judge("doc_comment_to_agent", comment(), world)).toEqual([
      "wake mira (doc_feedback) on doc doc-7",
    ]);

    expect(judge("doc_comment_to_agent", comment({ mentions: ["leo"] }), world)).toEqual([
      "wake leo (doc_feedback) on doc doc-7",
    ]);
  });

  it("hand_back_done and hand_back_blocked: the agent's own status move and hand-back", () => {
    const back = (status: string) =>
      event("agent.handed_back", {
        subject: { ticket: "ACME-1" },
        actor: SAM,
        data: { status, kind: "assigned" },
      });

    const world = (status: StaticTicket["status"]) => ({
      tickets: { "ACME-1": t(status, "sam", { requester: "ada.admin" }) },
    });

    expect(judge("hand_back_done", back("done"), world("active"))).toEqual([
      "act as sam: move ACME-1 to review, assign ACME-1 to human ada.admin",
    ]);

    expect(judge("hand_back_done", back("done"), world("blocked"))).toMatchObject({
      failed: { not: {} },
    });

    expect(judge("hand_back_blocked", back("blocked"), world("active"))).toEqual([
      "act as sam: move ACME-1 to blocked, assign ACME-1 to human ada.admin",
    ]);

    expect(judge("hand_back_blocked", back("done"), world("blocked"))).toEqual([
      "act as sam: assign ACME-1 to human ada.admin",
    ]);

    expect(judge("hand_back_blocked", back("waiting"), world("active"))).toMatchObject({
      failed: { any: expect.any(Array) },
    });
  });

  it("idle_pulls_next: an idle agent's oldest ready ticket", () => {
    const idle = event("agent.idle", { actor: SAM });
    const ready = { ready: { sam: [{ key: "ACME-5", readyAt: "2026-10-05T07:00:00.000Z" }] } };
    expect(judge("idle_pulls_next", idle, ready)).toEqual(["wake sam (assigned) on ticket ACME-5"]);
    expect(judge("idle_pulls_next", idle)).toEqual(["drop: no ready ticket is assigned to sam"]);
  });
});
