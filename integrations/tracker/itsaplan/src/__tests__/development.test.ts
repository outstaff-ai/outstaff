import { silentLogger, type AdapterContext } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { trackerOptions } from "#/index.js";
import { createItsaplanTracker } from "#/tracker.js";
import { API_KEY, createItsaplanFake, secretMap, team } from "@outstaff/testing.itsaplan";

const SHOP = { owner: "acme", name: "shop" };

async function setup() {
  const fake = createItsaplanFake();
  const ctx = {
    options: trackerOptions.parse({ url: "https://tracker.acme.example", project: "SHOP" }),
    secrets: secretMap({ ITSAPLAN_API_KEY: API_KEY }),
    team,
    log: silentLogger,
    fetch: fake.fetch,
    now: () => new Date("2026-01-01T00:00:00Z"),
  } satisfies AdapterContext<ReturnType<typeof trackerOptions.parse>>;

  const tracker = await createItsaplanTracker(ctx);
  const posts = () =>
    fake.calls.filter((c) => c.method === "POST" && c.path.endsWith("/development"));

  return { fake, tracker, posts };
}

describe("linking a pull request on an issue", () => {
  it("links a pull request of a connected repository, as the API key's member, by the issue's id", async () => {
    const { fake, tracker, posts } = await setup();
    await fake.trackerSeed.repository!(SHOP, [7]);
    const issue = await tracker.createIssue({ title: "Search", body: "" });
    expect(await tracker.linkPullRequest!(issue.key, { repo: SHOP, number: 7 })).toBe("linked");
    expect(posts().map((c) => [c.path, c.json])).toEqual([
      [`/issues/${issue.id}/development`, { repositoryId: 1, number: 7 }],
    ]);

    expect(fake.state.development).toMatchObject([{ number: 7, repositoryId: 1, by: "u-sam" }]);
  });

  it("leaves a pull request that is already linked as it is, matching the repository whatever its case", async () => {
    const { fake, tracker, posts } = await setup();
    await fake.trackerSeed.repository!({ owner: "Acme", name: "Shop" }, [7]);
    const issue = await tracker.createIssue({ title: "Search", body: "" });
    await tracker.linkPullRequest!(issue.key, { repo: SHOP, number: 7 });
    expect(await tracker.linkPullRequest!(issue.key, { repo: SHOP, number: 7 })).toBe(
      "already_linked",
    );

    expect(posts()).toHaveLength(1);
  });

  it("says a repository is not connected, and changes nothing", async () => {
    const { fake, tracker, posts } = await setup();
    await fake.trackerSeed.repository!(SHOP, [7]);
    const issue = await tracker.createIssue({ title: "Search", body: "" });
    const elsewhere = { repo: { owner: "acme", name: "ops" }, number: 7 };
    expect(await tracker.linkPullRequest!(issue.key, elsewhere)).toBe("not_connected");
    expect(posts()).toEqual([]);
  });

  it("reads the listing page by page, and reports a pull request the tracker does not list", async () => {
    const { fake, tracker } = await setup();
    const numbers = Array.from({ length: 45 }, (_, i) => i + 1);
    await fake.trackerSeed.repository!(SHOP, numbers);
    const issue = await tracker.createIssue({ title: "Search", body: "" });
    expect(await tracker.linkPullRequest!(issue.key, { repo: SHOP, number: 44 })).toBe("linked");
    await expect(
      tracker.linkPullRequest!(issue.key, { repo: SHOP, number: 99 }),
    ).rejects.toMatchObject({
      code: "not_found",
      message: "The tracker does not list pull request acme/shop#99.",
    });

    const pages = fake.calls
      .filter((c) => c.path.endsWith("/pull-requests"))
      .map((c) => `${c.query.get("page")} ${c.query.get("state")}`);

    expect(pages).toEqual(["1 all", "2 all", "3 all", "1 all", "2 all", "3 all"]);
  });
});

describe("the connected repositories", () => {
  it("lists them through any issue of the project, a nested owner included", async () => {
    const { fake, tracker } = await setup();
    await fake.trackerSeed.repository!(SHOP, []);
    await fake.trackerSeed.repository!({ owner: "acme/platform", name: "ops" }, []);
    await tracker.createIssue({ title: "Any", body: "" });
    expect(await tracker.connectedRepositories!()).toEqual([
      SHOP,
      { owner: "acme/platform", name: "ops" },
    ]);
  });

  it("cannot tell before the project has an issue", async () => {
    const { tracker } = await setup();
    await expect(tracker.connectedRepositories!()).rejects.toMatchObject({ code: "not_found" });
  });
});
