import { describe, expect, it } from "vitest";
import { SAM, judge, event } from "./support.js";

const idle = event("agent.idle", { actor: SAM });
const at = "2026-10-05T08:00:00.000Z";

describe("idle_pulls_next", () => {
  it("an idle agent's next ready ticket", () => {
    const ready = { ready: { sam: [{ key: "ACME-5", readyAt: "2026-10-05T07:00:00.000Z" }] } };
    expect(judge("idle_pulls_next", idle, ready)).toEqual(["wake sam (assigned) on ticket ACME-5"]);
    expect(judge("idle_pulls_next", idle)).toEqual(["drop: no ready ticket is assigned to sam"]);
  });

  it("skips a ticket the agent handed back silent, with nobody else acting on it since, and says so", () => {
    const ready = {
      ready: {
        sam: [
          { key: "ACME-6", readyAt: "2026-10-05T07:30:00.000Z", silencedAt: at },
          { key: "ACME-5", readyAt: "2026-10-05T07:00:00.000Z", silencedAt: at },
        ],
      },
    };

    expect(judge("idle_pulls_next", idle, ready)).toEqual([
      `drop: sam handed back ACME-5 silent at ${at}, ACME-6 silent at ${at}, and no one else acted on them since: not pulled again until someone does`,
    ]);

    const one = { ready: { sam: [ready.ready.sam[1]!] } };
    expect(judge("idle_pulls_next", idle, one)).toEqual([
      `drop: sam handed back ACME-5 silent at ${at}, and no one else acted on it since: not pulled again until someone does`,
    ]);
  });

  it("still pulls a different ready ticket, and the silenced one again once someone else acted on it", () => {
    const silenced = { key: "ACME-5", readyAt: "2026-10-05T07:00:00.000Z", silencedAt: at };
    const other = { key: "ACME-7", readyAt: "2026-10-05T09:00:00.000Z" };
    expect(judge("idle_pulls_next", idle, { ready: { sam: [silenced, other] } })).toEqual([
      "wake sam (assigned) on ticket ACME-7",
    ]);

    // Released: the work state no longer marks it.
    const released = { key: "ACME-5", readyAt: silenced.readyAt };
    expect(judge("idle_pulls_next", idle, { ready: { sam: [released, other] } })).toEqual([
      "wake sam (assigned) on ticket ACME-5",
    ]);
  });
});
