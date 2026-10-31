import { silentLogger, type WorkflowEvent } from "@outstaff/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStarted } from "#/office-started.js";
import { openStore } from "#/store/open.js";
import type { NewWorkItem, Store } from "#/store/types.js";
import type { WorkState } from "#/workstate/types.js";

const REPO = { host: "github.com", owner: "acme", name: "app" };

describe("the start of an item", () => {
  let store: Store;
  let judged: { event: WorkflowEvent; externalId: string }[];
  let refreshed: string[];
  let warned: string[];
  let refreshFails: boolean;
  let judgeFails: boolean;

  beforeEach(async () => {
    store = await openStore("sqlite::memory:");
    judged = [];
    refreshed = [];
    warned = [];
    refreshFails = false;
    judgeFails = false;
  });

  afterEach(async () => {
    await store.close();
  });

  const started = () =>
    createStarted({
      store,
      workState: {
        async refreshTicket(key: string) {
          if (refreshFails) {
            throw new Error("tracker down");
          }

          refreshed.push(key);
        },
      } as unknown as WorkState,
      async judge(event, meta) {
        if (judgeFails) {
          throw new Error("store down");
        }

        judged.push({ event, externalId: meta.externalId });
      },
      log: { ...silentLogger, warn: (m) => void warned.push(m) },
    });

  const item = (over: Partial<NewWorkItem> = {}) =>
    store.enqueue({ person: "sam", kind: "assigned", title: "t", trigger: "human", ...over });

  it("raises agent.started for the item's ticket, read again first, once per run", async () => {
    const w = await item({ subject: { type: "ticket", ref: "ACME-1" } });
    await started()(w);
    expect(refreshed).toEqual(["ACME-1"]);
    expect(judged).toEqual([
      {
        event: {
          type: "agent.started",
          subject: { ticket: "ACME-1" },
          actor: { kind: "agent", id: "sam" },
          data: { workItem: w.id, kind: "assigned" },
        },
        externalId: `started:${w.id}:0`,
      },
    ]);

    const run = await store.startRun(w.id);
    await started()(w);
    expect(judged[1]?.externalId).toBe(`started:${w.id}:${run.id}`);
  });

  it("raises it for a pull request's ticket, and not for a pull request without one or other subjects", async () => {
    await store.upsertSubject("pr", "acme/app#4", {
      ref: { repo: REPO, number: 4 },
      ticket: "ACME-4",
    });

    await store.upsertSubject("pr", "acme/app#5", { ref: { repo: REPO, number: 5 } });
    const onPr = await item({ kind: "ci_failed", subject: { type: "pr", ref: "acme/app#4" } });
    await started()(onPr);
    expect(judged.map((j) => j.event.subject)).toEqual([
      { pr: { repo: REPO, number: 4 }, ticket: "ACME-4" },
    ]);

    for (const subject of [
      { type: "pr", ref: "acme/app#5" },
      { type: "pr", ref: "acme/app#6" },
      { type: "chat", ref: "C1:1.0" },
    ]) {
      await started()(await item({ kind: "chat", subject }));
    }

    await started()(await item());
    expect(judged).toHaveLength(1);
  });

  it("logs a failed read or judgement and never throws: the work starts anyway", async () => {
    const w = await item({ subject: { type: "ticket", ref: "ACME-1" } });
    refreshFails = true;
    await started()(w);
    expect(judged).toHaveLength(1);
    judgeFails = true;
    await expect(started()(w)).resolves.toBeUndefined();
    expect(warned).toEqual([
      "refreshing the ticket before a start failed",
      "refreshing the ticket before a start failed",
      "judging the start of an item failed",
    ]);
  });
});
