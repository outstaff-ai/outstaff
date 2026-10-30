import { describe, expect, it } from "vitest";
import { SAM, judge, event } from "./support.js";

describe("idle_pulls_next", () => {
  it("an idle agent's next ready ticket", () => {
    const idle = event("agent.idle", { actor: SAM });
    const ready = { ready: { sam: [{ key: "ACME-5", readyAt: "2026-10-05T07:00:00.000Z" }] } };
    expect(judge("idle_pulls_next", idle, ready)).toEqual(["wake sam (assigned) on ticket ACME-5"]);
    expect(judge("idle_pulls_next", idle)).toEqual(["drop: no ready ticket is assigned to sam"]);
  });
});
