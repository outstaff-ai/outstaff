import { createFakeTracker } from "@outstaff/core/fakes";
import { describe, expect, it } from "vitest";
import type { Act } from "../../decisions.types.js";
import { createMemoryTraceStore } from "../../memory-traces.js";
import type { Trace } from "../../trace.types.js";
import { createOfficeActExecutor } from "../office-executor.js";
import { actId, recordActResult } from "../results.js";

const act = (ticket = "ACME-1", note?: string): Act => ({
  type: "act",
  policy: "hand_back_done",
  as: "sam",
  ops: [{ op: "move", ticket, to: "review" }],
  ...(note ? { note } : {}),
});

const trace = (id: string): Trace => ({
  event: {
    id,
    type: "agent.handed_back",
    at: "2026-10-05T09:00:00.000Z",
    subject: { ticket: "ACME-1" },
    actor: { kind: "agent", id: "sam" },
    data: {},
  },
  policies: [],
  decisions: [act()],
});

describe("recordActResult", () => {
  it("puts the result on the event's trace, and ignores an event with none", async () => {
    const traces = createMemoryTraceStore();
    await traces.record(trace("e"));
    await recordActResult(traces, "e", actId("e", "hand_back_done"), {
      ok: true,
      results: ["moved"],
    });

    await recordActResult(traces, "missing", "x", { ok: true, results: [] });
    expect((await traces.get("e"))?.results).toEqual({
      "e:hand_back_done": { ok: true, results: ["moved"] },
    });

    expect(await traces.get("missing")).toBeUndefined();

    // A re-evaluated event keeps what its acts did.
    await traces.record(trace("e"));
    expect((await traces.get("e"))?.results).toEqual({
      "e:hand_back_done": { ok: true, results: ["moved"] },
    });
  });
});

describe("the office act executor", () => {
  it("makes the changes with the office's account, posts the note saying whom they are for, and records the result", async () => {
    const office = { id: "u-office", name: "Office", kind: "agent" as const };
    const tracker = createFakeTracker({ actor: office });
    const issue = await tracker.createIssue({ title: "t", body: "", status: "active" });
    const traces = createMemoryTraceStore();
    await traces.record(trace("e"));
    const exec = createOfficeActExecutor({ team: { people: [] }, tracker, traces });
    await exec.execute(act(issue.key, "Moved to review for sam."), "e");
    await exec.execute(act(issue.key, "Moved to review for sam."), "e");

    expect((await traces.get("e"))?.results).toEqual({
      "e:hand_back_done": {
        ok: true,
        results: [`moved ${issue.key} to review`, `commented on ${issue.key}`],
      },
    });

    const history = (await tracker.events()).events.filter((e) => e.key === issue.key);
    expect(history.filter((e) => e.type !== "created").map((e) => [e.type, e.actor.id])).toEqual([
      ["moved", "u-office"],
      ["commented", "u-office"],
    ]);

    expect((await tracker.listComments(issue.key)).map((c) => c.body)).toEqual([
      "Moved to review for sam.",
    ]);
  });

  it("posts no note without one or without a ticket, and records a failure", async () => {
    const tracker = createFakeTracker();
    const traces = createMemoryTraceStore();
    await traces.record(trace("e"));
    await traces.record(trace("f"));
    const exec = createOfficeActExecutor({ team: { people: [] }, tracker, traces });
    await exec.execute(act("ACME-404"), "e");
    expect((await traces.get("e"))?.results).toEqual({
      "e:hand_back_done": {
        ok: false,
        results: [],
        error: "move ACME-404: Issue ACME-404 not found.",
      },
    });

    const docOnly: Act = {
      type: "act",
      policy: "p",
      as: "sam",
      ops: [{ op: "comment", on: { doc: "doc-7" }, body: "x" }],
      note: "For sam.",
    };

    await exec.execute(docOnly, "f");
    expect((await traces.get("f"))?.results?.["f:p"]).toEqual({
      ok: false,
      results: [],
      error: "comment: no knowledge base is configured",
    });
  });
});
