import { describe, expect, it } from "vitest";
import { findVerb, runVerb } from "#/verbs/index.js";
import type { PrListResult } from "#/verbs/office.types.js";
import { fakeEnv } from "@outstaff/testing.agent";

const pr = (
  number: number,
  patch: Partial<PrListResult["prs"][number]> = {},
): PrListResult["prs"][number] => ({
  ref: `acme/shop#${number}`,
  number,
  title: `Change ${number}`,
  url: `https://git.acme.example/acme/shop/pull/${number}`,
  state: "open",
  draft: false,
  author: "sam",
  ci: "success",
  mergeable: "clean",
  unresolvedThreads: 0,
  updatedAt: "2030-01-01T00:00:00Z",
  ...patch,
});

function setup(answer: PrListResult) {
  const f = fakeEnv();
  f.office.prList = async (filter) => {
    f.office.prListsAsked.push(filter);
    return answer;
  };

  const run = (input: Record<string, unknown> = {}) => runVerb(findVerb("pr.list")!, f.env, input);
  return { ...f, run };
}

describe("ost pr list", () => {
  it("asks the office for every pull request it keeps and shows state, CI, review and ticket", async () => {
    const f = setup({
      prs: [
        pr(12, {
          draft: true,
          ci: "failure",
          review: "changes_requested",
          mergeable: "conflicting",
          unresolvedThreads: 2,
          ticket: "SHOP-3",
        }),
        pr(9, { state: "merged", review: "approved", ticket: "SHOP-1", author: "mira" }),
        pr(8, { state: "closed", url: undefined }),
      ],
      more: 4,
    });

    const r = await f.run();
    expect(f.office.prListsAsked).toEqual([{ state: "all", limit: 25 }]);
    expect(r.text.split("\n")).toEqual([
      "Pull requests (state all), as the office tracks them now; merged and closed ones only while recent:",
      "- acme/shop#12 [open] Change 12 · draft · CI failure · review changes requested · conflicts · 2 open threads · ticket SHOP-3 · by sam · https://git.acme.example/acme/shop/pull/12",
      "- acme/shop#9 [merged] Change 9 · CI success · review approved · ticket SHOP-1 · by mira · https://git.acme.example/acme/shop/pull/9",
      "- acme/shop#8 [closed] Change 8 · CI success · review none · no ticket · by sam",
      "…and 4 more. Narrow it with --state, --author, --ticket or --repo, or raise --limit.",
    ]);

    expect(r.links).toEqual([
      "https://git.acme.example/acme/shop/pull/12",
      "https://git.acme.example/acme/shop/pull/9",
    ]);
  });

  it("passes the filters on, with the repository as owner/name", async () => {
    const f = setup({ prs: [], more: 0 });
    const r = await f.run({
      state: "open",
      author: "me",
      ticket: "SHOP-3",
      repo: "shop",
      limit: 5,
    });

    expect(f.office.prListsAsked).toEqual([
      { state: "open", author: "me", ticket: "SHOP-3", repo: "acme-example/shop", limit: 5 },
    ]);

    expect(r.text).toBe(
      "No pull requests match (state open, author me, ticket SHOP-3, repository acme-example/shop).",
    );
  });

  it("refuses a repository that is not the team's and works only with an office", async () => {
    const f = setup({ prs: [], more: 0 });
    await expect(f.run({ repo: "elsewhere" })).rejects.toMatchObject({ code: "not_found" });
    const bare = fakeEnv({ office: false });
    await expect(runVerb(findVerb("pr.list")!, bare.env, {})).rejects.toMatchObject({
      code: "unavailable",
    });
  });
});
