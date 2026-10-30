import type { Logger } from "@outstaff/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPO, teamConfig } from "#/intake/__tests__/test-support.js";
import { schedulerWorkSource } from "#/work-source.js";
import { readOrigin } from "#/chat/origin.js";
import { readFeedback } from "#/engine/feedback.js";
import { harness, SAM, type Harness } from "./test-support.js";

// Feedback for a pull request whose review round is already queued or running joins that round.

describe("feedback during a review round", () => {
  let h: Harness;
  let lines: { level: string; message: string }[];

  beforeEach(async () => {
    lines = [];
    const logger: Logger = {
      debug() {},
      info: (message) => void lines.push({ level: "info", message }),
      warn: (message) => void lines.push({ level: "warn", message }),
      error: (message) => void lines.push({ level: "error", message }),
    };

    h = await harness({ logger });
    await h.human("Dana");
  });

  afterEach(() => h.close());

  const source = () =>
    schedulerWorkSource({
      scheduler: h.scheduler,
      store: h.store,
      team: h.team,
      onHandedBack: (item) => h.engine.followUp(item.id),
    });

  const pullRequest = async () => {
    const issue = await h.tracker.createIssue({
      title: "Search",
      body: "",
      status: "review",
      assignee: "u-sam",
      labels: [],
    });

    await h.ws.apply(
      {
        type: "ticket.created",
        subject: { ticket: issue.key },
        actor: { kind: "human", id: "dana" },
        data: {},
      },
      { source: "tracker", externalId: `c-${issue.key}`, trusted: true },
    );

    const pr = await h.vcs.seed.pullRequest(REPO, {
      title: `${issue.key} change`,
      head: { ref: `sam/${issue.key.toLowerCase()}` },
      author: { login: SAM, kind: "agent" },
    });

    await h.poll();
    return pr;
  };

  const comment = async (number: number, body: string) => {
    h.clock.advance(5000);
    await h.vcs.seed.comment(REPO, number, "dana", body);
    await h.poll();
  };

  const bodies = (feedback: { body: string }[] | undefined) => (feedback ?? []).map((f) => f.body);

  it("lists two comments five seconds apart in one queued item, oldest first", async () => {
    const pr = await pullRequest();
    await comment(pr.number, "Rename the flag.");
    await comment(pr.number, "And add a test.");

    const items = await h.items("sam");
    expect(items.map((i) => [i.kind, i.status])).toEqual([["review_feedback", "queued"]]);
    expect(bodies(await readFeedback(h.store, items[0]!.id))).toEqual([
      "Rename the flag.",
      "And add a test.",
    ]);

    const offer = await source().next("sam");
    expect(bodies(offer?.context.feedback)).toEqual(["Rename the flag.", "And add a test."]);
    expect(offer?.context.feedback?.map((f) => [f.kind, typeof f.commentId])).toEqual([
      ["comment", "string"],
      ["comment", "string"],
    ]);

    expect(lines.filter((l) => l.level === "warn")).toEqual([]);
    expect(
      lines.some((l) => /attached to work item .* \(review_feedback, queued\)/.test(l.message)),
    ).toBe(true);
  });

  it("starts exactly one follow-up round for a comment that arrived while the item ran", async () => {
    const pr = await pullRequest();
    const work = source();
    await comment(pr.number, "Rename the flag.");
    const offer = (await work.next("sam"))!;
    await work.accept("sam", offer.workItem.id, { runtime: "claude", model: "sonnet" });
    expect(bodies(offer.context.feedback)).toEqual(["Rename the flag."]);

    await comment(pr.number, "And add a test.");
    expect((await h.items("sam")).map((i) => i.status)).toEqual(["active"]);
    expect(lines.filter((l) => l.level === "warn")).toEqual([]);
    expect(lines.some((l) => /attached to work item .* running/.test(l.message))).toBe(true);

    const result = { summary: "Renamed it.", links: [], status: "done" as const };
    await work.handBack("sam", offer.workItem.id, result);
    await work.handBack("sam", offer.workItem.id, result);

    const items = await h.items("sam");
    const followUps = items.filter((i) => i.status === "queued");
    expect(followUps.map((i) => i.kind)).toEqual(["review_feedback"]);
    expect(followUps[0]?.parentId).toBe(offer.workItem.id);

    const next = (await work.next("sam"))!;
    expect(next.workItem.id).toBe(followUps[0]!.id);
    expect(bodies(next.context.feedback)).toEqual(["And add a test."]);
    await work.handBack("sam", next.workItem.id, result);
    expect((await h.items("sam")).filter((i) => i.status === "queued")).toEqual([]);
  });

  it("offers the follow-up round with its feedback and the origin of every linked thread", async () => {
    const pr = await pullRequest();
    const work = source();
    await comment(pr.number, "Rename the flag.");
    const offer = (await work.next("sam"))!;
    await work.accept("sam", offer.workItem.id, { runtime: "claude", model: "sonnet" });
    await h.store.upsertSubject("chat_origin", offer.workItem.id, {
      channel: "D1",
      thread: "t1",
      requester: { id: "U-a" },
      awaitingPlacement: false,
      claimed: ["ack"],
      also: [{ channel: "D1", thread: "t2", requester: { id: "U-b" } }],
    });

    await comment(pr.number, "And add a test.");
    await work.handBack("sam", offer.workItem.id, { summary: "Done.", links: [], status: "done" });

    // The origin and the feedback are stored before the item can start, so its first offer has both.
    const next = (await work.next("sam"))!;
    expect(bodies(next.context.feedback)).toEqual(["And add a test."]);
    expect(next.workItem.origin).toEqual({
      channel: "D1",
      thread: "t1",
      requester: { id: "U-a" },
    });

    expect(await readOrigin(h.store, next.workItem.id)).toMatchObject({
      claimed: [],
      also: [{ thread: "t2" }],
    });
  });

  it("starts no follow-up round when policies.feedback.follow_up_round is off", async () => {
    await h.close();
    h = await harness({
      team: teamConfig({
        humans: [{ name: "Dana", identities: { vcs: "dana", tracker: "dana", chat: "U-dana" } }],
        policies: { feedback: { follow_up_round: false } },
      }),
    });

    await h.human("Dana");
    const pr = await pullRequest();
    const work = source();
    await comment(pr.number, "Rename the flag.");
    const offer = (await work.next("sam"))!;
    await work.accept("sam", offer.workItem.id, { runtime: "claude", model: "sonnet" });
    await comment(pr.number, "And add a test.");
    await work.handBack("sam", offer.workItem.id, { summary: "Done.", links: [], status: "done" });
    expect((await h.items("sam")).filter((i) => i.status === "queued")).toEqual([]);
  });

  it("starts no follow-up when everything was in the offer", async () => {
    const pr = await pullRequest();
    const work = source();
    await comment(pr.number, "Rename the flag.");
    const offer = (await work.next("sam"))!;
    await work.handBack("sam", offer.workItem.id, { summary: "Done.", links: [], status: "done" });
    expect((await h.items("sam")).filter((i) => i.status === "queued")).toEqual([]);
  });
});
