import { describe, expect, it } from "vitest";
import { groupNotices, guardText, renderNotice } from "#/pipeline/notify/render.js";

describe("guardText", () => {
  it("keeps every line, and no mention, channel or group ping", () => {
    expect(
      guardText("\n  Done: <@U0BOSS> and <!channel>, see <#C123>.  \n\nSecond.\nThird.\n"),
    ).toBe("Done: @U0BOSS and !channel, see #C123.\n\nSecond.\nThird.");
  });

  it("keeps a long message whole", () => {
    const long = Array.from({ length: 12 }, (_, i) => `- point ${i}: ${"x".repeat(80)}`).join("\n");
    expect(guardText(long)).toBe(long);
  });
});

describe("renderNotice", () => {
  const ticket = { key: "ACME-91", url: "https://t/ACME-91", title: "Preview builds" };
  const pr = { ref: "acme/app#70", url: "https://g/70", head: "0123456789abcdef" };

  it("links the pull requests before the ticket they are for, and the ticket alone without one", () => {
    const line = (prs: { ref: string; url?: string; head?: string }[], need = "review" as const) =>
      renderNotice([{ need, ticket, prs }]);

    expect(line([pr, { ref: "acme/app#71" }])).toBe(
      "Ready for your review: pull requests [acme/app#70](https://g/70) (checks passed on 0123456), acme/app#71, for [ACME-91](https://t/ACME-91) Preview builds",
    );

    expect(renderNotice([{ need: "blocked", ticket, prs: [] }])).toBe(
      "Blocked, needs you: [ACME-91](https://t/ACME-91) Preview builds",
    );
  });

  it("leads with the agent's message, and links the pull request and ticket after it", () => {
    expect(
      renderNotice([
        {
          need: "review",
          ticket,
          prs: [pr],
          text: "Addressed the review on acme/app#70: own preview step and top-level env.\nAnswered the question about caching without a change.",
        },
      ]),
    ).toBe(
      [
        "Addressed the review on acme/app#70: own preview step and top-level env.",
        "Answered the question about caching without a change.",
        "Ready for your review: pull request [acme/app#70](https://g/70) (checks passed on 0123456), for [ACME-91](https://t/ACME-91) Preview builds",
      ].join("\n"),
    );
  });

  it("posts a long message whole, without its mentions", () => {
    const points = Array.from(
      { length: 20 },
      (_, i) => `- review point ${i} addressed in \`preview.yml\``,
    );

    const body = renderNotice([
      {
        need: "blocked",
        ticket: { key: "ACME-92" },
        prs: [],
        text: [`Need a decision from <@U0BOSS>:`, ...points].join("\n"),
      },
    ]);

    expect(body.split("\n")).toEqual([
      "Need a decision from @U0BOSS:",
      ...points,
      "Blocked, needs you: ACME-92",
    ]);
  });

  it("lists several items, each with its words first and its links under them", () => {
    expect(
      renderNotice([
        { need: "review", ticket, prs: [pr], text: "Added the preview step.\n\nNothing else." },
        { need: "review", prs: [{ ref: "acme/app#71" }] },
      ]),
    ).toBe(
      [
        "Waiting for you:",
        "- Added the preview step.",
        "",
        "  Nothing else.",
        "  Ready for your review: pull request [acme/app#70](https://g/70) (checks passed on 0123456), for [ACME-91](https://t/ACME-91) Preview builds",
        "- Ready for your review: pull request acme/app#71",
      ].join("\n"),
    );
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
