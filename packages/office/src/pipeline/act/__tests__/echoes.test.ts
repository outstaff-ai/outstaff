import type { ActOp, TeamConfig, TicketAssignee } from "@outstaff/core";
import type { PipelineEvent } from "@outstaff/policy";
import { afterEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import { openStore, type Store } from "#/store/index.js";
import { event, stateOf } from "#/pipeline/__tests__/support.js";
import { createActEchoes } from "#/pipeline/act/echoes.js";
import type { Act } from "#/pipeline/decisions.types.js";
import { t, traceOf } from "#/pipeline/policies/__tests__/support.js";

const SAM = { kind: "agent" as const, id: "sam" };
const PIA = { kind: "agent" as const, id: "pia" };
const PM = { kind: "agent" as const, id: "priya" };

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

/** The act of `hand_back_blocked_to_pm` when the PM is priya, without its note. */
const toPmOps: ActOp[] = [
  { op: "move", ticket: "ACME-1", to: "blocked" },
  { op: "assign", ticket: "ACME-1", to: { kind: "agent", id: "priya" } },
];

/** The state after the act: blocked, with pia. */
const after = stateOf({ tickets: { "ACME-1": { status: "blocked", assignee: PIA } } });

/** When the tests' events happen, and the acts are sent. */
const NOW = event("ticket.assigned").at;

const assigned = (
  id: string,
  actor: PipelineEvent["actor"] = SAM,
  data: Record<string, unknown> = {},
  at = NOW,
) => event("ticket.assigned", { id, subject: { ticket: "ACME-1" }, actor, data, at });

let store: Store | undefined;
afterEach(async () => {
  await store?.close();
  store = undefined;
});

/** The team file: each agent's tracker identity is its username in the tracker, not its handle. */
const TEAM = {
  people: [
    { handle: "sam", name: "Sam Duarte", identities: { tracker: "sam.duarte" } },
    { handle: "priya", name: "Priya Raman", identities: { tracker: "priya.raman" } },
  ],
} as unknown as TeamConfig;

async function harness() {
  store = await openStore("sqlite::memory:");
  const clock = manualClock(NOW);
  return { echoes: createActEchoes(store, clock, TEAM), clock };
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
    const later = clock.now().toISOString();
    expect(await echoes.of(assigned("t:1", SAM, {}, later), after)).toBe("a2");
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
      manualClock(NOW),
      TEAM,
    );

    await expect(echoes.expect("sam", { id: "a1", ops: toPm })).rejects.toThrow("store down");
    await echoes.expect("sam", { id: "a2", ops: toPm });
    expect(await echoes.of(assigned("t:1"), after)).toBe("a2");
  });

  describe("an assignment, whatever name the act gives its assignee", () => {
    /** The act a built-in policy decides for sam's blocked hand-back of ACME-1, as it is sent. */
    const actOf = (policy: string, roles: Record<string, string>): ActOp[] => {
      const back = event("agent.handed_back", {
        subject: { ticket: "ACME-1" },
        actor: SAM,
        data: { status: "blocked", kind: "assigned", summary: "The staging key is missing." },
      });

      const world = {
        tickets: { "ACME-1": t("active", "sam", { requester: "ada.admin" }) },
        roles,
      };

      const act = traceOf(back, world).decisions.find(
        (d): d is Act => d.type === "act" && d.policy === policy,
      )!;

      return act.ops;
    };

    /** The state once the tracker reports ACME-1 blocked and assigned to the member. */
    const withMember = (assignee: TicketAssignee) =>
      stateOf({ tickets: { "ACME-1": { status: "blocked", assignee } } });

    /** Priya as the tracker has her: member u-7, whose username is the tracker identity the team file gives. */
    const PRIYA = ["u-7", "priya.raman", "Priya Raman"];

    /** Ada as the tracker has her: member u-1, username ada.admin. */
    const ADA = ["u-1", "ada.admin", "Ada Admin"];

    it("recognises the PM named by role, as the state knows her by her handle or only by her tracker member", async () => {
      const ops = actOf("hand_back_blocked_to_pm", { pm: "priya" });
      expect(ops).toContainEqual({
        op: "assign",
        ticket: "ACME-1",
        to: { kind: "agent", id: "priya" },
      });

      const { echoes } = await harness();
      const forms: TicketAssignee[] = [
        { kind: "agent", id: "priya", names: PRIYA },
        { kind: "agent", id: "u-7", names: PRIYA },
        { kind: "agent", id: "u-7", names: ["u-7", "Priya.Raman"] },
      ];

      for (const [i, assignee] of forms.entries()) {
        await echoes.expect("sam", { id: `a${i}`, ops });
        expect(await echoes.of(assigned(`t:${i}`), withMember(assignee))).toBe(`a${i}`);
      }
    });

    it("recognises an agent named by handle, and not an assignment to someone else", async () => {
      const { echoes } = await harness();
      const ops: ActOp[] = [{ op: "assign", ticket: "ACME-1", to: { kind: "agent", id: "priya" } }];
      await echoes.expect("sam", { id: "a1", ops });

      const sam = { kind: "agent" as const, id: "u-2", names: ["u-2", "sam.duarte", "Sam Duarte"] };
      expect(await echoes.of(assigned("t:1"), withMember(sam))).toBeUndefined();
      expect(await echoes.of(assigned("t:1"), withMember({ kind: "agent", id: "u-7" }))).toBe(
        undefined,
      );

      expect(
        await echoes.of(assigned("t:1"), withMember({ kind: "agent", id: "u-7", names: PRIYA })),
      ).toBe("a1");
    });

    it("recognises a human named as the requester, by member id or by display name", async () => {
      const ops = actOf("hand_back_blocked", {});
      expect(ops).toContainEqual({
        op: "assign",
        ticket: "ACME-1",
        to: { kind: "human", id: "ada.admin" },
      });

      const ada = { kind: "human" as const, id: "ada.admin", names: ADA };
      const named = (id: string): ActOp[] => [
        { op: "assign", ticket: "ACME-1", to: { kind: "human", id } },
      ];

      const { echoes } = await harness();
      const grace = withMember({ kind: "human", id: "grace", names: ["u-9", "grace"] });
      for (const [i, act] of [ops, named("u-1"), named("Ada Admin")].entries()) {
        await echoes.expect("sam", { id: `a${i}`, ops: act });
        expect(await echoes.of(assigned(`g:${i}`), grace)).toBeUndefined();
        expect(await echoes.of(assigned(`t:${i}`), withMember(ada))).toBe(`a${i}`);
      }
    });
  });

  describe("an event that is late", () => {
    const at = (seconds: number) => new Date(Date.parse(NOW) + seconds * 1000).toISOString();
    const moved = (id: string, to: string, when: string) =>
      event("ticket.moved", {
        id,
        subject: { ticket: "ACME-1" },
        actor: SAM,
        data: { to },
        at: when,
      });

    /** Members as the tracker reports them in an assignment event. */
    const SAM_MEMBER = { id: "u-2", username: "sam.duarte", name: "Sam Duarte", kind: "agent" };
    const PRIYA_MEMBER = { id: "u-7", username: "priya.raman", name: "Priya Raman", kind: "agent" };

    /** Blocked, with the PM: the state once the hand-back's act is made. */
    const handedToPm = stateOf({
      tickets: {
        "ACME-1": {
          status: "blocked",
          assignee: { kind: "agent", id: "priya", names: ["u-7", "priya.raman", "Priya Raman"] },
        },
      },
    });

    it("is the echo of the change it reports, not of a later act the state already shows", async () => {
      const { echoes, clock } = await harness();
      // The round starts: sam's process takes the ticket and makes it active.
      await echoes.expect("sam", {
        id: "start",
        ops: [
          { op: "assign", ticket: "ACME-1", to: SAM },
          { op: "move", ticket: "ACME-1", to: "active" },
        ],
      });

      // Thirty seconds on, sam hands it back blocked: to the PM.
      clock.advance(30_000);
      await echoes.expect("sam", {
        id: "back",
        ops: [
          { op: "move", ticket: "ACME-1", to: "blocked" },
          { op: "assign", ticket: "ACME-1", to: PM },
        ],
      });

      // The start's events come in only now, when the state is already the hand-back's.
      const startAssigned = assigned("t:1", SAM, { assignee: SAM_MEMBER, to: "Sam Duarte" }, at(0));
      expect(await echoes.of(startAssigned, handedToPm)).toBe("start");
      expect(await echoes.of(moved("t:2", "active", at(0)), handedToPm)).toBe("start");

      // The hand-back's own events are still its echoes.
      expect(await echoes.of(moved("t:3", "blocked", at(30)), handedToPm)).toBe("back");
      const pmAssigned = assigned(
        "t:4",
        SAM,
        { assignee: PRIYA_MEMBER, to: "Priya Raman" },
        at(30),
      );

      expect(await echoes.of(pmAssigned, handedToPm)).toBe("back");
    });

    it("never spends a later act's change, even with no act of its own", async () => {
      const { echoes, clock } = await harness();
      clock.advance(30_000);
      await echoes.expect("sam", { id: "back", ops: toPmOps });

      // Showing someone else, or from well before the act, it is no echo; the act's own events still are.
      const stale = assigned("t:1", SAM, { to: "Sam Duarte" }, at(29));
      expect(await echoes.of(stale, handedToPm)).toBeUndefined();
      expect(await echoes.of(moved("t:2", "blocked", at(0)), handedToPm)).toBeUndefined();
      expect(await echoes.of(moved("t:3", "blocked", at(26)), handedToPm)).toBe("back");

      // A feed that shows only the display name is matched through the state's member.
      expect(await echoes.of(assigned("t:4", SAM, { to: "Priya Raman" }, at(30)), handedToPm)).toBe(
        "back",
      );
    });

    it("tells an unassignment by what the event says", async () => {
      const { echoes } = await harness();
      await echoes.expect("sam", {
        id: "a1",
        ops: [{ op: "assign", ticket: "ACME-1", to: null }],
      });

      const none = stateOf({ tickets: { "ACME-1": { status: "blocked" } } });
      expect(await echoes.of(assigned("t:1", SAM, { assignee: SAM_MEMBER }), none)).toBeUndefined();
      expect(await echoes.of(assigned("t:2", SAM, { assignee: null }), handedToPm)).toBe("a1");
    });
  });
});
