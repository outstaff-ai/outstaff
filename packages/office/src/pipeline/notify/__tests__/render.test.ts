import { describe, expect, it } from "vitest";
import { groupNotices, guardText, renderNotice } from "#/pipeline/notify/render.js";

describe("guardText", () => {
  it("keeps the first two lines, and no mention, channel or group ping", () => {
    expect(guardText("\n  Done: <@U0BOSS> and <!channel>, see <#C123>.\n\nSecond.\nThird.")).toBe(
      "Done: @U0BOSS and !channel, see #C123.\nSecond.",
    );
  });

  it("cuts a long line", () => {
    const said = guardText("x".repeat(400));
    expect(said).toHaveLength(300);
    expect(said.endsWith("…")).toBe(true);
  });
});

describe("groupNotices and renderNotice", () => {
  it("merges a ticket's notices: every pull request once, the latest need and words", () => {
    const groups = groupNotices([
      {
        event: "1",
        at: "",
        need: "review",
        ticket: "ACME-1",
        prs: [{ ref: "a/b#1" }],
        text: "Old.",
      },
      { event: "2", at: "", need: "blocked", ticket: "ACME-1", prs: [{ ref: "a/b#1", url: "u" }] },
      { event: "3", at: "", need: "review", prs: [{ ref: "a/b#2" }] },
      { event: "4", at: "", need: "review", prs: [] },
    ]);

    expect(groups).toEqual([
      { need: "blocked", ticket: "ACME-1", prs: [{ ref: "a/b#1", url: "u" }], text: "Old." },
      { need: "review", prs: [{ ref: "a/b#2" }] },
      { need: "review", prs: [] },
    ]);

    expect(renderNotice([{ need: "review", prs: [{ ref: "a/b#2" }] }])).toBe(
      "Ready for your review: pull request a/b#2",
    );
  });
});
