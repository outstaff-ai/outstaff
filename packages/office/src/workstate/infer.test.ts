import { describe, expect, it } from "vitest";
import { ticketCandidates } from "./infer.js";

describe("ticketCandidates", () => {
  it("prefers closing references, then the branch, then the title", () => {
    expect(
      ticketCandidates({
        headRef: "sam/acme-12-search",
        title: "ACME-7 tweak",
        body: "Mentions ACME-99.\n\nCloses ACME-5",
      }),
    ).toEqual(["ACME-5", "ACME-12", "ACME-7", "ACME-99"]);
  });

  it("accepts the usual closing words and punctuation", () => {
    for (const word of ["Closes", "fixes:", "Resolved", "Refs", "implements"]) {
      expect(ticketCandidates({ headRef: "x", title: "t", body: `${word} ACME-3` })[0]).toBe(
        "ACME-3",
      );
    }
  });

  it("finds nothing in plain text and does not repeat keys", () => {
    expect(ticketCandidates({ headRef: "main-fix", title: "Fix it", body: "" })).toEqual([]);
    expect(ticketCandidates({ headRef: "acme-1", title: "ACME-1", body: "Closes acme-1" })).toEqual(
      ["ACME-1"],
    );
  });
});
