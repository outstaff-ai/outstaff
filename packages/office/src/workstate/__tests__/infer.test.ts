import { describe, expect, it } from "vitest";
import { ticketCandidates } from "#/workstate/infer.js";

const keys = (pr: { headRef: string; title: string; body?: string }) =>
  ticketCandidates(pr).map((c) => c.key);

describe("ticketCandidates", () => {
  it("prefers the branch, then the title, then a closing keyword, and names the source", () => {
    expect(
      ticketCandidates({
        headRef: "sam/acme-12-search",
        title: "ACME-7 tweak",
        body: "Mentions ACME-99.\n\nCloses ACME-5",
      }),
    ).toEqual([
      { key: "ACME-12", source: "branch" },
      { key: "ACME-7", source: "title" },
      { key: "ACME-5", source: "closing keyword" },
    ]);
  });

  it("links a closing keyword in the body, the title and the branch alone", () => {
    expect(ticketCandidates({ headRef: "x", title: "t", body: "Closes ACME-1" })).toEqual([
      { key: "ACME-1", source: "closing keyword" },
    ]);

    expect(ticketCandidates({ headRef: "x", title: "ACME-1: t" })).toEqual([
      { key: "ACME-1", source: "title" },
    ]);

    expect(ticketCandidates({ headRef: "feat/acme-1-x", title: "t" })).toEqual([
      { key: "ACME-1", source: "branch" },
    ]);
  });

  it("does not link a bare mention in the body", () => {
    expect(
      keys({ headRef: "x", title: "t", body: "After deploying, ask the agent to retry ACME-104." }),
    ).toEqual([]);

    expect(keys({ headRef: "x", title: "t", body: "Refs ACME-3, see also ACME-4" })).toEqual([]);
  });

  it("accepts the GitHub closing words, case-insensitively, with optional colon", () => {
    for (const word of [
      "close",
      "Closes",
      "CLOSED",
      "fix",
      "fixes:",
      "Fixed",
      "resolve",
      "Resolves",
      "resolved",
    ]) {
      expect(keys({ headRef: "x", title: "t", body: `${word} ACME-3` })).toEqual(["ACME-3"]);
    }
  });

  it("lets the branch outrank a different key in a closing keyword", () => {
    expect(keys({ headRef: "sam/acme-2-x", title: "t", body: "Closes ACME-9" })).toEqual([
      "ACME-2",
      "ACME-9",
    ]);
  });

  it("adds a repository's own ticket_link patterns and ignores unusable ones", () => {
    const pr = { headRef: "x", title: "t", body: "Ticket: acme-8\nsee ACME-9" };
    expect(ticketCandidates(pr, ["Ticket: {key}"])).toEqual([
      { key: "ACME-8", source: "ticket_link" },
    ]);

    expect(ticketCandidates(pr, ["(", "no placeholder"])).toEqual([]);
    expect(ticketCandidates(pr)).toEqual([]);
  });

  it("finds nothing in plain text and does not repeat keys", () => {
    expect(keys({ headRef: "main-fix", title: "Fix it", body: "" })).toEqual([]);
    expect(keys({ headRef: "acme-1", title: "ACME-1", body: "Closes acme-1" })).toEqual(["ACME-1"]);
  });
});
