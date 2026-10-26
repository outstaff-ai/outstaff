import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TeamConfig } from "@outstaff/core";
import { createFakeVcs } from "@outstaff/core/fakes";
import type { Feedback } from "@outstaff/protocol";
import { manualClock } from "../clock.js";
import { previousConversation } from "../conversation-context.js";
import { addFeedback } from "../engine/feedback.js";
import { createScheduler } from "../scheduler/index.js";
import { openStore } from "../store/open.js";
import type { Store } from "../store/types.js";
import { schedulerWorkSource } from "../work-source.js";

const team = {
  people: [],
  policies: {
    agent_loop_guard: { max_runs_per_item_per_hour: 12 },
    usage: { defer_scheduled_at: 0.85, pause_automatic_at: 0.95 },
    retry: { base_minutes: 1, cap_minutes: 30, max_failures: 2 },
  },
} as unknown as Pick<TeamConfig, "people" | "humans" | "policies">;

describe("the conversation before a round", () => {
  let store: Store;
  beforeEach(async () => {
    store = await openStore("sqlite://:memory:");
  });

  afterEach(async () => {
    await store.close();
  });

  const setup = async () => {
    const vcs = createFakeVcs();
    const repo = vcs.seed.repo;
    const pr = await vcs.seed.pullRequest(repo, { title: "Add cart" });
    await store.upsertSubject("pr", "acme/app#1", {
      ref: { repo, number: pr.number },
      title: pr.title,
      headRef: "feat/1",
      baseRef: "main",
      state: "open",
      author: { login: "acme-sam[bot]", kind: "agent", person: "sam" },
    });

    const subject = { type: "pr", ref: "acme/app#1" };
    return { vcs, repo, pr, subject };
  };

  const triggerOf = async (
    vcs: Awaited<ReturnType<typeof setup>>["vcs"],
    repo: Awaited<ReturnType<typeof setup>>["repo"],
    number: number,
    body: string,
  ): Promise<Feedback> => {
    await vcs.seed.comment(repo, number, "ada-admin", body);
    const trigger = (await vcs.conversation(repo, number)).at(-1)!;
    return { actor: "ada-admin", kind: "comment", body, at: trigger.at, url: trigger.url };
  };

  it("returns the last five entries before the triggering comment, oldest first", async () => {
    const { vcs, repo, pr, subject } = await setup();
    for (let i = 1; i <= 7; i++) {
      await vcs.seed.comment(repo, pr.number, i % 2 ? "acme-sam[bot]" : "ada-admin", `entry ${i}`);
    }

    const trigger = await triggerOf(vcs, repo, pr.number, "Yes, do it");
    await vcs.seed.comment(repo, pr.number, "ada-admin", "written after the trigger");

    const found = await previousConversation(store, vcs, { subject }, [trigger]);
    expect(found.map((e) => e.body)).toEqual([
      "entry 3",
      "entry 4",
      "entry 5",
      "entry 6",
      "entry 7",
    ]);

    expect(found[0]).toMatchObject({ kind: "comment", author: "acme-sam[bot]" });
    expect(found[0]!.url).toContain("issuecomment");
  });

  it("trims long bodies and includes review summaries with their state", async () => {
    const { vcs, repo, pr, subject } = await setup();
    await vcs.seed.comment(repo, pr.number, "acme-sam[bot]", "x".repeat(5000));
    await vcs.seed.review(repo, pr.number, "grace-lead", "changes_requested", "Add a test");
    const trigger = await triggerOf(vcs, repo, pr.number, "ok");
    const found = await previousConversation(store, vcs, { subject }, [trigger]);
    expect(found[0]!.body.length).toBeLessThan(700);
    expect(found[0]!.body).toContain("ost pr conversation");
    expect(found[1]).toMatchObject({ kind: "review", state: "changes_requested" });
  });

  it("adds nothing for inline-only feedback, other subjects, or a host that cannot be read", async () => {
    const { vcs, repo, pr, subject } = await setup();
    await vcs.seed.comment(repo, pr.number, "acme-sam[bot]", "earlier");
    const trigger = await triggerOf(vcs, repo, pr.number, "ok");
    const inline: Feedback = { ...trigger, kind: "inline_comment" };
    expect(await previousConversation(store, vcs, { subject }, [inline])).toEqual([]);
    expect(
      await previousConversation(store, vcs, { subject: { type: "ticket", ref: "SHOP-1" } }, [
        trigger,
      ]),
    ).toEqual([]);

    expect(await previousConversation(store, vcs, { subject }, [{ ...trigger, at: "" }])).toEqual(
      [],
    );

    const broken = { conversation: () => Promise.reject(new Error("rate limited")) };
    expect(await previousConversation(store, broken, { subject }, [trigger])).toEqual([]);
  });

  it("is part of the offer of a comment-triggered round", async () => {
    const { vcs, repo, pr, subject } = await setup();
    const clock = manualClock();
    const scheduler = createScheduler({ store, team, clock });
    const source = schedulerWorkSource({ scheduler, store, team, ports: { vcs } });
    await vcs.seed.comment(repo, pr.number, "acme-sam[bot]", "I could cache the lookup.");
    const item = await scheduler.enqueue({
      person: "sam",
      kind: "review_feedback",
      title: "review",
      trigger: "human",
      subject,
    });

    await addFeedback(store, item.id, await triggerOf(vcs, repo, pr.number, "Yes, do it"));
    const offer = await source.next("sam");
    expect(offer?.context.feedback?.[0]?.body).toBe("Yes, do it");
    expect(offer?.context.conversation?.map((e) => e.body)).toEqual(["I could cache the lookup."]);
  });
});
