import { describe, expect, it } from "vitest";
import { wakesIn } from "#/office-log.ts";

const line = (verb: string, item: string, person: string, kind: string) =>
  JSON.stringify({
    level: "info",
    message: `pipeline: ${verb} work item ${item} for ${person} (${kind})`,
  });

describe("wakesIn", () => {
  it("counts a wake folded into an open item as the round it joined, not a second one", () => {
    const log = [
      line("queued", "w1", "pia", "milestone"),
      line("folded the wake into", "w1", "pia", "milestone"),
    ].join("\n");

    expect(wakesIn(log, "pia")).toEqual(["milestone"]);
  });

  it("keeps one kind per item, the one that queued it, in the order the items were queued", () => {
    const log = [
      line("queued", "w1", "sam", "assigned"),
      line("queued", "w2", "pia", "unblock"),
      line("folded the wake into", "w1", "sam", "comment"),
      line("queued", "w3", "sam", "ci_failed"),
      line("queued", "w4", "sam", "comment"),
    ].join("\n");

    expect(wakesIn(log, "sam")).toEqual(["assigned", "ci_failed", "comment"]);
    expect(wakesIn(log, "pia")).toEqual(["unblock"]);
  });

  it("counts a fold into an item it has not seen queued as that item's round", () => {
    expect(wakesIn(line("folded the wake into", "w9", "sam", "chat"), "sam")).toEqual(["chat"]);
  });

  it("ignores other lines and other people", () => {
    const log = [
      "queued work item w1 for sam again: 1 new feedback and 0 answers while it ran",
      line("queued", "w2", "samuel", "assigned"),
    ].join("\n");

    expect(wakesIn(log, "sam")).toEqual([]);
  });
});
