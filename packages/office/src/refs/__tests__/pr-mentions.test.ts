import { describe, expect, it } from "vitest";
import { MAX_PR_MENTIONS, prMentionsIn } from "#/refs/index.js";

describe("the pull requests a text names", () => {
  it("reads a link and owner/repo#n with their repository", () => {
    expect(
      prMentionsIn(
        "See https://git.acme.example/acme/App/pull/57 and acme/infra#3, also https://git.acme.example/acme/app/pulls/9.",
      ),
    ).toEqual([
      { number: 57, repo: "acme/app" },
      { number: 9, repo: "acme/app" },
      { number: 3, repo: "acme/infra" },
    ]);
  });

  it('reads "PR n", "PR #n", "pull request n" and a bare #n without one', () => {
    expect(prMentionsIn("CI still fails on PR 57")).toEqual([{ number: 57 }]);
    expect(prMentionsIn("pr #12, Pull Request 13 and #14")).toEqual([
      { number: 12 },
      { number: 13 },
      { number: 14 },
    ]);
  });

  it("names each once, and leaves out a bare number its repository already named", () => {
    expect(prMentionsIn("PR #57 again: #57, acme/app#57 and acme/web#57")).toEqual([
      { number: 57, repo: "acme/app" },
      { number: 57, repo: "acme/web" },
    ]);
  });

  it("reads no number out of words, paths or anchors", () => {
    expect(prMentionsIn("step2#3 ACME-75 UTF-8 page.html#5 PRs 4")).toEqual([]);
  });

  it(`stops at ${MAX_PR_MENTIONS}`, () => {
    expect(prMentionsIn("#1 #2 #3 #4 #5 #6 #7")).toHaveLength(MAX_PR_MENTIONS);
  });
});
