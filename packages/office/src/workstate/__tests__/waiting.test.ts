import { createFakeTracker, createFakeVcs } from "@outstaff/core/fakes";
import { beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import { teamConfig } from "#/intake/__tests__/test-support.js";
import { openStore } from "#/store/open.js";
import type { Store } from "#/store/types.js";
import type { ManualClock } from "#/types.js";
import type { HeardEvent, WorkState } from "#/workstate/index.js";
import { WAITING_SUBJECT } from "#/workstate/waiting.js";
import { createWorkState } from "#/workstate/workstate.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const SAM = { kind: "agent", id: "sam" };
const NOOR = { kind: "agent", id: "noor" };
const ADA = { kind: "human", id: "ada.admin" };
const GRACE = { kind: "human", id: "grace" };
const DESIGN = "ACME-2";

describe("agents waiting on a human in the work state", () => {
  let clock: ManualClock;
  let store: Store;
  let ws: WorkState;

  const build = async () => {
    ws = await createWorkState({
      store,
      ports: { vcs: createFakeVcs({ now: clock.now }), tracker: createFakeTracker() },
      team: teamConfig(),
      clock,
      logger: silent,
      retentionMs: 3 * 24 * 3_600_000,
    });
  };

  beforeEach(async () => {
    clock = manualClock("2026-10-05T08:00:00.000Z");
    store = await openStore("sqlite::memory:");
    await build();
  });

  /** A comment on the ticket, a minute after the last thing that happened. */
  const said = async (
    actor: HeardEvent["actor"],
    data: Record<string, unknown> = {},
    ticket = DESIGN,
  ) => {
    clock.advance(60_000);
    const at = clock.now().toISOString();
    await ws.heard({ type: "ticket.commented", at, actor, subject: { ticket }, data });
    return at;
  };

  const asks = (actor = SAM, data: Record<string, unknown> = {}, ticket = DESIGN) =>
    said(actor, { mentionedHumans: ["ada.admin"], ...data }, ticket);

  /** Who waits on ada on the ticket when she comments a minute from now. */
  const waiting = (human = "ada.admin", ticket = DESIGN) =>
    ws
      .waitingOn(ticket, human, new Date(clock.now().getTime() + 60_000).toISOString())
      .map((w) => w.agent);

  it("makes an agent that mentions the human wait on them there, until their next comment answers it", async () => {
    const at = await asks(SAM, { url: "https://tracker.acme.example/ACME-2#comment-1" });
    expect(ws.waitingOn(DESIGN, "ada.admin", "2026-10-05T09:00:00.000Z")).toEqual([
      { agent: "sam", at, url: "https://tracker.acme.example/ACME-2#comment-1" },
    ]);

    // Named in any case, as the tracker names them; on another ticket, or another human, no one waits.
    expect(waiting("ADA.ADMIN")).toEqual(["sam"]);
    expect(waiting("ada.admin", "ACME-3")).toEqual([]);
    expect(waiting("grace")).toEqual([]);

    // Her answer is judged with sam waiting; once judged, a second comment of hers finds no one.
    await said(ADA, { body: "All good." });
    expect(waiting()).toEqual([]);

    // Unless sam asks again.
    await asks();
    expect(waiting()).toEqual(["sam"]);
  });

  it("does not make an agent wait that never addressed the human", async () => {
    await said(SAM, { body: "Moved the mockups to the shared folder." });
    await said(SAM, { mentionedHumans: ["grace"] });
    expect(waiting()).toEqual([]);
    expect(waiting("grace")).toEqual(["sam"]);
  });

  it("does not count the human's earlier comment, nor an answer read before the question", async () => {
    await said(ADA, { body: "Any news?" });
    expect(waiting()).toEqual([]);
    const asked = await asks();
    // A comment of hers from before sam asked (read late) is no answer to it.
    expect(ws.waitingOn(DESIGN, "ada.admin", "2026-10-05T07:00:00.000Z")).toEqual([]);
    await ws.heard({
      type: "ticket.commented",
      at: "2026-10-05T07:30:00.000Z",
      actor: ADA,
      subject: { ticket: DESIGN },
      data: {},
    });

    expect(waiting()).toEqual(["sam"]);
    expect(ws.waitingOn(DESIGN, "ada.admin", asked)).toEqual([
      expect.objectContaining({ at: asked }),
    ]);

    // And a question read after her later answer, but written before it, was answered by it.
    const answered = await said(ADA, { body: "Go." });
    await ws.heard({
      type: "ticket.commented",
      at: new Date(Date.parse(answered) - 1_000).toISOString(),
      actor: NOOR,
      subject: { ticket: DESIGN },
      data: { mentionedHumans: ["ada.admin"] },
    });

    expect(waiting()).toEqual([]);
  });

  it("keeps every agent that waits, oldest first; the human's comment answers them all", async () => {
    await asks(NOOR);
    await asks(SAM);
    await asks(NOOR);
    expect(waiting()).toEqual(["sam", "noor"]);
    await said(ADA);
    expect(waiting()).toEqual([]);
  });

  it("leaves out an act's note, an untrusted human's comment, other events and comments with no ticket", async () => {
    await asks(SAM, { echo: "act-1" });
    expect(waiting()).toEqual([]);
    await asks();
    await said(ADA, { untrusted: true });
    await said({ kind: "automation", id: "ci-bot" }, { mentionedHumans: ["ada.admin"] });
    await ws.heard({
      type: "ticket.moved",
      at: clock.now().toISOString(),
      actor: ADA,
      subject: { ticket: DESIGN },
      data: {},
    });

    await ws.heard({
      type: "ticket.commented",
      at: clock.now().toISOString(),
      actor: ADA,
      subject: {},
      data: {},
    });

    expect(waiting()).toEqual(["sam"]);
  });

  it("keeps who waits across a restart, and forgets what is older than the retention", async () => {
    await asks();
    await said(GRACE);
    await build();
    expect(waiting()).toEqual(["sam"]);

    clock.advance(4 * 24 * 3_600_000);
    await asks(NOOR, {}, "ACME-3");
    expect(waiting()).toEqual([]);
    expect(waiting("ada.admin", "ACME-3")).toEqual(["noor"]);
    expect((await store.getSubject(WAITING_SUBJECT, "office"))?.data).toEqual({
      "ACME-3": { "ada.admin": { asks: { noor: expect.objectContaining({ agent: "noor" }) } } },
    });
  });
});
