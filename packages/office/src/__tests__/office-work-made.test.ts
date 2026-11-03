import { createFakeTracker, createFakeVcs } from "@outstaff/core/fakes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import { teamConfig } from "#/intake/__tests__/test-support.js";
import { officeWorkMade } from "#/office-work-made.js";
import { openStore } from "#/store/open.js";
import type { Store } from "#/store/types.js";
import { createWorkState } from "#/workstate/workstate.js";
import type { WorkState } from "#/workstate/types.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

describe("what agents made in their work items", () => {
  let store: Store;
  let ws: WorkState;

  beforeEach(async () => {
    const clock = manualClock();
    store = await openStore("sqlite::memory:", { now: () => clock.now() });
    ws = await createWorkState({
      store,
      ports: { vcs: createFakeVcs({ now: clock.now }), tracker: createFakeTracker() },
      team: teamConfig(),
      clock,
      logger: silent,
    });
  });

  afterEach(async () => {
    await ws.stop();
    await store.close();
  });

  const item = () =>
    store.enqueue({ person: "sam", kind: "assigned", title: "t", trigger: "human" });

  it("records a ticket created as the item's, and a pull request opened with its ticket", async () => {
    const { id } = await item();
    const made = officeWorkMade({ store, workState: ws, log: silent });
    await made.made("sam", { workItemId: id, ticket: "ACME-2" });
    await made.made("sam", {
      workItemId: id,
      pr: { repo: { owner: "acme", name: "shop" }, number: 4, url: "https://git.acme.example/4" },
      ticket: "ACME-3",
    });

    await made.made("sam", {
      workItemId: id,
      pr: { repo: { owner: "acme", name: "shop" }, number: 5 },
    });

    await made.made("sam", { workItemId: id });

    const refs = (await store.listItemRefs(id)).map(({ type, ref, role, source }) => ({
      type,
      ref,
      role,
      source,
    }));

    expect(refs).toEqual(
      expect.arrayContaining([
        { type: "ticket", ref: "ACME-2", role: "created", source: "ticket_create" },
        {
          type: "pr",
          ref: expect.stringMatching(/acme\/shop#4$/),
          role: "created",
          source: "pr_open",
        },
        { type: "ticket", ref: "ACME-3", role: "inferred", source: "pr_open" },
        {
          type: "pr",
          ref: expect.stringMatching(/acme\/shop#5$/),
          role: "created",
          source: "pr_open",
        },
      ]),
    );

    expect(refs).toHaveLength(4);
  });

  it("refuses an item that is not the caller's", async () => {
    const { id } = await item();
    const made = officeWorkMade({ store, workState: ws, log: silent });
    await expect(made.made("noor", { workItemId: id, ticket: "ACME-2" })).rejects.toMatchObject({
      code: "unknown_item",
    });

    await expect(made.made("sam", { workItemId: "nope", ticket: "ACME-2" })).rejects.toMatchObject({
      code: "unknown_item",
    });
  });

  it("records the pull request even when the code host cannot be read", async () => {
    const { id } = await item();
    const workState = { ...ws, catchUp: () => Promise.reject(new Error("down")) } as WorkState;
    const made = officeWorkMade({ store, workState, log: silent });
    await made.made("sam", {
      workItemId: id,
      pr: { repo: { host: "git.acme.example", owner: "acme", name: "shop" }, number: 4 },
    });

    expect(await store.listItemRefs(id)).toHaveLength(1);
  });
});
