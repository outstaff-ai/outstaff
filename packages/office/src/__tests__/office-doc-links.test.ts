import { createFakeTracker, createFakeVcs } from "@outstaff/core/fakes";
import type { WorkflowEvent } from "@outstaff/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import { teamConfig } from "#/intake/__tests__/test-support.js";
import { officeDocLinks } from "#/office-doc-links.js";
import { openStore } from "#/store/open.js";
import type { Store } from "#/store/types.js";
import { createWorkState } from "#/workstate/workstate.js";
import type { WorkState } from "#/workstate/types.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const doc = { id: "42", title: "Cart design", url: "https://docs.acme.example/42" };

describe("the office's document links", () => {
  let store: Store;
  let ws: WorkState;
  let seen: WorkflowEvent[];
  const tracker = createFakeTracker();

  beforeEach(async () => {
    const clock = manualClock();
    store = await openStore("sqlite::memory:", { now: () => clock.now() });
    ws = await createWorkState({
      store,
      ports: { vcs: createFakeVcs({ now: clock.now }), tracker },
      team: teamConfig(),
      clock,
      logger: silent,
    });

    seen = [];
    ws.onEvent((e) => void seen.push(e));
  });

  afterEach(async () => {
    await ws.stop();
    await store.close();
  });

  const itemOn = (ticket?: string) =>
    store.enqueue({
      person: "sam",
      kind: "assigned",
      title: "t",
      trigger: "human",
      ...(ticket ? { subject: { type: "ticket", ref: ticket } } : {}),
    });

  it("records a document written in a round on a ticket, and raises doc.linked for it once", async () => {
    const issue = await tracker.createIssue({ title: "Cart", body: "" });
    await ws.refreshTicket(issue.key);
    const item = await itemOn(issue.key);
    const links = officeDocLinks({ store, workState: ws, log: silent });
    await links.link("sam", item.id, doc);
    await links.link("sam", item.id, { ...doc, title: "Cart design, revised" });

    expect(ws.doc("42")).toMatchObject({ author: "sam", ticket: issue.key });
    expect(seen).toMatchObject([
      {
        type: "doc.linked",
        subject: { doc: "42", ticket: issue.key },
        actor: { kind: "agent", id: "sam" },
        data: { ticket: issue.key, title: "Cart design", url: doc.url },
      },
    ]);

    expect(await store.listItemRefs(item.id)).toContainEqual(
      expect.objectContaining({ type: "doc", ref: "42", role: "created", source: "doc_link" }),
    );
  });

  it("links a document to the ticket the agent names, read from the tracker when it is new to the office", async () => {
    const item = await itemOn();
    const links = officeDocLinks({ store, workState: ws, log: silent });
    await links.link("sam", item.id, doc);
    expect(seen).toEqual([]);

    const issue = await tracker.createIssue({ title: "Cart", body: "" });
    await links.link("sam", item.id, doc, issue.key);
    expect(seen.map((e) => e.subject)).toEqual([{ doc: "42", ticket: issue.key }]);
    await expect(links.link("sam", item.id, doc, "ACME-404")).rejects.toMatchObject({
      code: "invalid",
      message: "No ticket ACME-404 is known to the office.",
    });
  });

  it("refuses a work item that is not the caller's", async () => {
    const item = await itemOn();
    const links = officeDocLinks({ store, workState: ws, log: silent });
    await expect(links.link("noor", item.id, doc)).rejects.toMatchObject({
      code: "unknown_item",
    });
  });
});
