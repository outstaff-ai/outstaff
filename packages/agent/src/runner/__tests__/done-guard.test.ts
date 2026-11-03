import type { RunRequest, Runtime, RuntimeEvent } from "@outstaff/core";
import { createFakeTracker } from "@outstaff/core/fakes";
import { fakeEnv } from "@outstaff/testing.agent";
import { describe, expect, it } from "vitest";
import type { Offer } from "#/office-client/index.js";
import type { ItemEnv, WorkerContext, WorkLoopOptions } from "#/runner/loop.types.js";
import { guardedHandBack } from "#/runner/work-done-guard.js";
import { NOTHING_TO_REVIEW, finishesSilently, toReview } from "#/runner/work-review.js";
import type { ItemRun } from "#/runner/work.types.js";
import type { DeclaredHandBack } from "#/verbs/types.js";

const offer = (kind: string, subjects: Offer["context"]["subjects"] = []): Offer => ({
  workItem: { id: "w1", kind, title: "Fix w1", priority: 1, trigger: "human" },
  context: { journal: [], subjects: [{ type: "ticket", ref: "SHOP-1" }, ...subjects], links: [] },
});

interface Did {
  produced?: string[];
  moved?: [string, string][];
  asked?: boolean;
  declared?: DeclaredHandBack;
}

const itemOf = (did: Did): ItemEnv => ({
  env: fakeEnv().env,
  moved: new Map(did.moved ?? []),
  asked: () => did.asked ?? false,
  filedWork: () => false,
  produced: () => did.produced ?? [],
  declared: () => did.declared,
});

const runOf = (o: Offer, item: ItemEnv): ItemRun => ({
  offer: o,
  abort: new AbortController(),
  storedSession: undefined,
  chatContext: undefined,
  item,
  request: (prompt, resume): RunRequest => ({
    ...(resume ? { sessionId: resume } : {}),
    workItemId: o.workItem.id,
    prompt,
    systemPrompt: "x",
    workdir: "/w",
    addDirs: [],
    policy: {} as RunRequest["policy"],
    tools: [],
    builtinTools: [],
    model: "sonnet",
  }),
  prompt: () => "work",
  current: "s1",
  lastText: "",
  usage: new Map(),
});

describe("toReview", () => {
  const found = (o: Offer, did: Did = {}) => toReview(runOf(o, itemOf(did)));

  it.each([
    "chat",
    "question",
    "asked",
    "ticket_comment",
    "doc_feedback",
    "unblock",
    "merge",
    "review_feedback",
    "merged_feedback",
    "rebase",
    "ci_failed",
    "merge_checks_failed",
  ])("has nothing to review for a %s item that made nothing, which may finish silently", (kind) => {
    const run = runOf(offer(kind), itemOf({}));
    expect(toReview(run)).toEqual([]);
    expect(finishesSilently(run)).toBe(true);
    expect(finishesSilently(runOf(offer(kind), itemOf({ declared: "done" })))).toBe(false);
  });

  it("finds nothing for a ticket the round left without a result, which never finishes silently", () => {
    for (const kind of ["assigned", "unblocked", "request"]) {
      expect(found(offer(kind))).toEqual([]);
      expect(finishesSilently(runOf(offer(kind), itemOf({ declared: "silent" })))).toBe(false);
    }
  });

  it("counts what the agent made, and the tickets it closed or canceled", () => {
    const did = {
      produced: ["opened pull request acme/app#2 (draft)", "linked document https://d/1"],
      moved: [
        ["SHOP-1", "done"],
        ["SHOP-2", "canceled"],
        ["SHOP-3", "review"],
        ["SHOP-4", "active"],
      ] as [string, string][],
    };

    expect(found(offer("assigned"), did)).toEqual([
      "opened pull request acme/app#2 (draft)",
      "linked document https://d/1",
      "moved SHOP-1 to done",
      "moved SHOP-2 to canceled",
      "moved SHOP-3 to review",
    ]);
  });

  it("counts a pull request of the item open for review, not a draft or a closed one", () => {
    const o = offer("assigned", [
      { type: "pr", ref: "acme/app#1", state: "open", draft: false },
      { type: "pr", ref: "acme/app#2", state: "open", draft: true },
      { type: "pr", ref: "acme/app#3", state: "closed", draft: false },
      { type: "pr", ref: "acme/app#4", state: "merged" },
    ]);

    expect(found(o)).toEqual(["pull request acme/app#1 is open for review"]);
  });
});

/** A runtime that plays one round per call: each round may change what the item did, then ends with its text. */
function rounds(...plays: { text: string; effect?: () => void }[]) {
  const requests: RunRequest[] = [];
  const runtime: Runtime = {
    async *run(req): AsyncGenerator<RuntimeEvent> {
      requests.push(req);
      const play = plays.shift() ?? { text: "" };
      play.effect?.();
      yield { type: "finished", ok: true, text: play.text };
    },
  };

  return { runtime, requests };
}

function contextOf(runtime: Runtime) {
  const logs: string[] = [];
  const log = (m: string) => void logs.push(m);
  const ctx: WorkerContext = {
    opts: {
      runtime,
      office: { progress: async () => {} },
      env: { ...fakeEnv().env, tracker: createFakeTracker() },
    } as unknown as WorkLoopOptions,
    log: { debug() {}, info: log, warn: log, error() {} },
    sessions: { resumeFor: () => undefined, started: async () => {} },
  };

  return { ctx, logs };
}

describe("guardedHandBack", () => {
  it("hands back done with what there is to review, without asking again", async () => {
    const { runtime, requests } = rounds();
    const { ctx } = contextOf(runtime);
    const run = runOf(offer("assigned"), itemOf({ produced: ["opened pull request acme/app#2"] }));
    expect(await guardedHandBack(ctx, run, "Opened it.")).toEqual({
      status: "done",
      summary: "Opened it.",
      toReview: ["opened pull request acme/app#2"],
    });

    expect(requests).toEqual([]);
  });

  it("refuses done once, in the same session, then hands back blocked with the agent's answer", async () => {
    const { runtime, requests } = rounds({ text: "Blocked: need the tone from Ada." });
    const { ctx, logs } = contextOf(runtime);
    const run = runOf(offer("assigned"), itemOf({}));
    expect(await guardedHandBack(ctx, run, "Waiting on Ada.")).toEqual({
      status: "blocked",
      summary: "Blocked: need the tone from Ada.",
      toReview: [],
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.sessionId).toBe("s1");
    expect(requests[0]!.prompt.split("\n")[0]).toBe(NOTHING_TO_REVIEW);
    expect(requests[0]!.prompt).toContain("It is handed back as `blocked`");
    expect(logs.join("\n")).toContain("handing back as blocked");
  });

  it("keeps the first message when the second round fails", async () => {
    const runtime: Runtime = {
      async *run() {
        yield { type: "finished", ok: false, text: "", error: "overloaded" };
      },
    };

    const { ctx } = contextOf(runtime);
    const result = await guardedHandBack(ctx, runOf(offer("assigned"), itemOf({})), "Waiting.");
    expect(result).toMatchObject({ status: "blocked", summary: "Waiting." });
  });

  it("goes back as interrupted when the agent shuts down during the second round", async () => {
    const run = runOf(offer("assigned"), itemOf({}));
    const runtime: Runtime = {
      async *run() {
        run.abort.abort();
        yield { type: "finished", ok: false, text: "", interrupted: true };
      },
    };

    const { ctx } = contextOf(runtime);
    expect(await guardedHandBack(ctx, run, "Waiting.")).toMatchObject({
      interrupted: true,
      summary: "Waiting.",
    });
  });

  it("is done when the second round makes a result to review", async () => {
    const did: Did = {};
    const { runtime } = rounds({
      text: "Opened acme/app#2.",
      effect: () => (did.produced = ["opened pull request acme/app#2"]),
    });

    const { ctx } = contextOf(runtime);
    expect(await guardedHandBack(ctx, runOf(offer("assigned"), itemOf(did)), "x")).toEqual({
      status: "done",
      summary: "Opened acme/app#2.",
      toReview: ["opened pull request acme/app#2"],
    });
  });

  it("waits when the second round asks another agent", async () => {
    const did: Did = {};
    const { runtime } = rounds({ text: "Asked mira.", effect: () => (did.asked = true) });
    const { ctx } = contextOf(runtime);
    const result = await guardedHandBack(ctx, runOf(offer("assigned"), itemOf(did)), "x");
    expect(result).toMatchObject({ status: "waiting", summary: "Asked mira." });
  });

  it("finishes a comment round that made nothing silently, without asking again", async () => {
    const { runtime, requests } = rounds();
    const { ctx } = contextOf(runtime);
    const run = runOf(offer("ticket_comment"), itemOf({}));
    expect(await guardedHandBack(ctx, run, "Nothing for me.")).toEqual({
      status: "silent",
      summary: "Nothing for me.",
      toReview: [],
    });

    expect(requests).toEqual([]);
  });

  it("refuses a comment round the agent said is done with nothing to review, and blocks it", async () => {
    const { runtime, requests } = rounds({ text: "Blocked: need the tone from the requester." });
    const { ctx } = contextOf(runtime);
    const run = runOf(offer("ticket_comment"), itemOf({ declared: "done" }));
    expect(await guardedHandBack(ctx, run, "Asked which tone.")).toMatchObject({
      status: "blocked",
      summary: "Blocked: need the tone from the requester.",
    });

    expect(requests).toHaveLength(1);
  });

  it("is done for a comment round with an answer the agent moved to review", async () => {
    const { runtime } = rounds();
    const { ctx } = contextOf(runtime);
    const run = runOf(offer("ticket_comment"), itemOf({ moved: [["SHOP-1", "review"]] }));
    expect(await guardedHandBack(ctx, run, "Answered.")).toMatchObject({
      status: "done",
      toReview: ["moved SHOP-1 to review"],
    });
  });

  it("is blocked when the agent said so, whatever else holds", async () => {
    const { runtime } = rounds();
    const { ctx } = contextOf(runtime);
    const did: Did = {
      declared: "blocked",
      asked: true,
      produced: ["opened pull request acme/app#2"],
    };

    const run = runOf(offer("assigned"), itemOf(did));
    expect(await guardedHandBack(ctx, run, "Blocked.")).toMatchObject({ status: "blocked" });
  });

  it("does not ask again for a waiting or blocked hand-back", async () => {
    const { runtime, requests } = rounds();
    const { ctx } = contextOf(runtime);
    const run = runOf(offer("assigned"), itemOf({ asked: true }));
    expect(await guardedHandBack(ctx, run, "Asked.")).toMatchObject({ status: "waiting" });
    expect(requests).toEqual([]);
  });
});
