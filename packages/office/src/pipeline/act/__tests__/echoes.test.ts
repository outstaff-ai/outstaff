import type { ActOp } from "@outstaff/core";
import type { PipelineEvent } from "@outstaff/policy";
import { afterEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import { openStore, type Store } from "#/store/index.js";
import { event, stateOf } from "#/pipeline/__tests__/support.js";
import { createActEchoes } from "#/pipeline/act/echoes.js";

const SAM = { kind: "agent" as const, id: "sam" };
const PIA = { kind: "agent" as const, id: "pia" };

/** The act of `hand_back_blocked_to_pm` for sam: blocked, assigned to pia, with its note. */
const toPm: ActOp[] = [
  { op: "move", ticket: "ACME-1", to: "blocked" },
  { op: "assign", ticket: "ACME-1", to: PIA },
  {
    op: "comment",
    on: { ticket: "ACME-1" },
    body: "Moved to blocked and assigned to the team's PM.",
  },
];

/** The state after the act: blocked, with pia. */
const after = stateOf({ tickets: { "ACME-1": { status: "blocked", assignee: PIA } } });

const assigned = (id: string, actor: PipelineEvent["actor"] = SAM) =>
  event("ticket.assigned", { id, subject: { ticket: "ACME-1" }, actor });

let store: Store | undefined;
afterEach(async () => {
  await store?.close();
  store = undefined;
});

async function harness() {
  store = await openStore("sqlite::memory:");
  const clock = manualClock();
  return { echoes: createActEchoes(store, clock), clock };
}

describe("the echoes of acts", () => {
  it("recognises each change of an act once, as the acting agent's event that shows it", async () => {
    const { echoes } = await harness();
    await echoes.expect("sam", { id: "a1", ops: toPm, event: "e1" });

    // Another agent's assignment, or one that leaves the ticket with someone else, is not the echo.
    expect(await echoes.of(assigned("t:1", PIA), after)).toBeUndefined();
    const elsewhere = stateOf({ tickets: { "ACME-1": { status: "blocked", assignee: SAM } } });
    expect(await echoes.of(assigned("t:1"), elsewhere)).toBeUndefined();

    expect(await echoes.of(assigned("t:1"), after)).toBe("a1");

    // The same event delivered again is still the echo; a later assignment by sam is not.
    expect(await echoes.of(assigned("t:1"), after)).toBe("a1");
    expect(await echoes.of(assigned("t:2"), after)).toBeUndefined();

    const moved = event("ticket.moved", { id: "t:3", subject: { ticket: "ACME-1" }, actor: SAM });
    expect(await echoes.of(moved, after)).toBe("a1");

    const note = (body: string) =>
      event("ticket.commented", {
        id: `t:${body.length}`,
        subject: { ticket: "ACME-1" },
        actor: SAM,
        data: { body },
      });

    expect(await echoes.of(note("Something else."), after)).toBeUndefined();
    expect(await echoes.of(note("Moved to blocked and assigned to the team's PM."), after)).toBe(
      "a1",
    );
  });

  it("expects an act sent again once, ignores changes with no echo, and only agents' ticket events echo", async () => {
    const { echoes } = await harness();
    const ops: ActOp[] = [
      { op: "set_parent", ticket: "ACME-1", parent: "ACME-0" },
      { op: "comment", on: { doc: "doc-1" }, body: "Noted." },
      { op: "assign", ticket: "ACME-1", to: null },
    ];

    await echoes.expect("sam", { id: "a1", ops });
    await echoes.expect("sam", { id: "a1", ops });
    const unassigned = stateOf({ tickets: { "ACME-1": { status: "blocked" } } });
    expect(await echoes.of(assigned("t:1", { kind: "human", id: "ada" }), unassigned)).toBe(
      undefined,
    );

    expect(await echoes.of(event("pr.opened", { actor: SAM }), unassigned)).toBeUndefined();
    expect(await echoes.of(assigned("t:1"), unassigned)).toBe("a1");
    expect(await echoes.of(assigned("t:2"), unassigned)).toBeUndefined();
  });

  it("expects a change for a day: later it is an ordinary event, and it is forgotten", async () => {
    const { echoes, clock } = await harness();
    await echoes.expect("sam", { id: "a1", ops: toPm });
    clock.advance(24 * 60 * 60 * 1000);
    expect(await echoes.of(assigned("t:1"), after)).toBeUndefined();

    await echoes.expect("sam", { id: "a2", ops: [toPm[1]!] });
    const book = (await store!.getSubject("act_echo", "ACME-1"))?.data as {
      expected: { act: string }[];
    };

    expect(book.expected.map((e) => e.act)).toEqual(["a2"]);
    expect(await echoes.of(assigned("t:1"), after)).toBe("a2");
  });

  it("goes on after a write that failed", async () => {
    store = await openStore("sqlite::memory:");
    const real = store;
    let fail = true;
    const echoes = createActEchoes(
      {
        getSubject: (type, ref) => real.getSubject(type, ref),
        upsertSubject: (type, ref, data) => {
          if (fail) {
            fail = false;
            return Promise.reject(new Error("store down"));
          }

          return real.upsertSubject(type, ref, data);
        },
      },
      manualClock(),
    );

    await expect(echoes.expect("sam", { id: "a1", ops: toPm })).rejects.toThrow("store down");
    await echoes.expect("sam", { id: "a2", ops: toPm });
    expect(await echoes.of(assigned("t:1"), after)).toBe("a2");
  });
});
