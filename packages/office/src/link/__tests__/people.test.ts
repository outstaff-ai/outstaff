import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WAKE_SUBJECT } from "#/pipeline/live/wake.js";
import { openStore, type Store } from "#/store/index.js";
import { listPeople } from "#/link/people.js";

describe("listPeople", () => {
  let store: Store;
  beforeEach(async () => {
    store = await openStore("sqlite::memory:");
  });

  afterEach(async () => {
    await store.close();
  });

  it("gives each person's connection, current item with its run, and queue in run order with why", async () => {
    const team = {
      people: [
        { handle: "sam", name: "Sam Duarte", role: "developer" },
        { handle: "noor", name: "Noor Haddad", role: "developer" },
        { handle: "kofi", name: "Kofi Mensah", role: "devops" },
      ] as never,
    };

    const active = await store.enqueue({
      person: "sam",
      kind: "assigned",
      title: "assigned: ACME-1",
      trigger: "human",
      subject: { type: "ticket", ref: "ACME-1" },
    });

    await store.activateItem(active.id);
    const run = await store.startRun(active.id);
    await store.tagRun(active.id, { runtime: "claude", model: "opus" });
    const later = await store.enqueue({
      person: "sam",
      kind: "review_feedback",
      title: "review feedback: PR #9",
      trigger: "human",
      priority: 50,
      position: 7,
    });

    const tie = await store.enqueue({
      person: "sam",
      kind: "asked",
      title: "asked: ACME-3",
      trigger: "agent",
      priority: 50,
      position: 7,
    });

    const first = await store.enqueue({
      person: "sam",
      kind: "ci_failed",
      title: "ci failed: PR #9",
      trigger: "automation",
      priority: 20,
    });

    await store.upsertSubject(WAKE_SUBJECT, first.id, {
      event: "workstate:pr.ci_failed:x",
      policy: "ci_failed_to_author",
    });

    const busy = await store.enqueue({
      person: "noor",
      kind: "assigned",
      title: "assigned: ACME-4",
      trigger: "human",
    });

    await store.activateItem(busy.id);

    const item = (
      i: { id: string; kind: string; title: string },
      extra: Record<string, unknown>,
    ) => ({
      id: i.id,
      kind: i.kind,
      title: i.title,
      subject: null,
      ...extra,
    });

    expect(await listPeople({ team, store, connected: () => ["sam"] })).toEqual([
      {
        handle: "sam",
        name: "Sam Duarte",
        role: "developer",
        connected: true,
        counts: { queued: 3, running: 1 },
        current: {
          ...item(active, {}),
          subject: { type: "ticket", ref: "ACME-1" },
          startedAt: run.startedAt,
          runtime: "claude",
          model: "opus",
          lastHeartbeat: expect.any(String),
        },
        queue: [
          item(first, {
            priority: 20,
            trigger: "automation",
            reason: "policy ci_failed_to_author on event workstate:pr.ci_failed:x",
            scheduledBy: { policy: "ci_failed_to_author", eventId: "workstate:pr.ci_failed:x" },
          }),
          item(later, {
            priority: 50,
            trigger: "human",
            reason: "human: review feedback",
            scheduledBy: null,
          }),
          item(tie, { priority: 50, trigger: "agent", reason: "agent: asked", scheduledBy: null }),
        ],
      },
      {
        handle: "noor",
        name: "Noor Haddad",
        role: "developer",
        connected: false,
        counts: { queued: 0, running: 1 },
        current: item(busy, {
          startedAt: null,
          runtime: null,
          model: null,
          lastHeartbeat: expect.any(String),
        }),
        queue: [],
      },
      {
        handle: "kofi",
        name: "Kofi Mensah",
        role: "devops",
        connected: false,
        counts: { queued: 0, running: 0 },
        current: null,
        queue: [],
      },
    ]);
  });
});
