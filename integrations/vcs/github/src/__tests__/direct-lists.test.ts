import { readFileSync } from "node:fs";
import { silentLogger, type VcsEvent } from "@outstaff/core";
import { appRoutes, build, REPO, type Route, type StubReply } from "@outstaff/testing.github";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RestEvent } from "#/api.types.js";
import { toVcsEvent } from "#/event-mapping.js";
import { listRoutes, type Lists } from "./lists.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const fixture = <T>(dir: string, name: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/${dir}/${name}.json`, import.meta.url), "utf8"));

const feedFixture = (name: string) => fixture<RestEvent>("events-feed", name);
const list = (name: string) => fixture<Record<string, unknown>[]>("direct-lists", name);

/** All three kinds, as the fixtures hold them: a pull request comment, an inline comment and a review on #8. */
const ALL: Lists = {
  comments: list("issue-comments"),
  inline: list("pull-comments"),
  pulls: list("pulls"),
  reviews: { 8: list("reviews") },
};

const feedRoute = (events: () => unknown[] | StubReply): Route => ({
  method: "GET",
  path: "/repos/acme/app/events",
  handler: () => events(),
});

/** A cursor whose feed and lists both read up to `since`. */
const cursorAt = (since: string, direct: Record<string, unknown> = { since }) =>
  JSON.stringify({ "acme/app": { since, direct } });

const STEADY = cursorAt("2026-01-05T09:59:00Z");

/** An event as compared across routes: what the feed's fixture leaves out (`url`) is not compared. */
const comparable = (e: VcsEvent | undefined) => JSON.parse(JSON.stringify(e));

const keys = (page: { events: VcsEvent[] }) => page.events.map((e) => e.externalId);

describe("direct comment and review lists", () => {
  it("maps each item as the feed maps the same object, under the object's key", async () => {
    const { vcs, stub } = build([...appRoutes(), feedRoute(() => []), ...listRoutes(ALL)]);
    const page = await vcs.events([REPO], STEADY);
    expect(keys(page)).toEqual([
      "review_comment:4300000001",
      "comment:4400000001",
      "review:5600000005",
    ]);

    const byKey = new Map(page.events.map((e) => [e.externalId, e]));
    for (const name of [
      "pull-request-review-comment",
      "issue-comment-on-pull-request",
      "pull-request-review-commented",
    ]) {
      const feed = comparable(toVcsEvent(REPO, feedFixture(name)));
      expect(byKey.get(feed.externalId)).toMatchObject(feed);
    }

    // The comment on a plain issue, the pending and the old review are not news; #3 has not moved.
    expect(stub.called("GET", "/repos/acme/app/pulls/3/reviews")).toEqual([]);
    expect(stub.called("GET", "/repos/acme/app/issues/comments")[0]!.query.get("since")).toBe(
      "2026-01-05T09:54:00.000Z",
    );

    expect(JSON.parse(page.cursor)["acme/app"].direct).toEqual({
      since: "2026-01-05T10:00:10.000Z",
      reviewed: { "8": "2026-01-05T10:00:00Z" },
    });
  });

  it("reports a comment the feed shows late once per poll, under one key across polls", async () => {
    let feed: unknown[] = [];
    const { vcs } = build([
      ...appRoutes(),
      feedRoute(() => feed),
      ...listRoutes({ comments: list("issue-comments") }),
    ]);

    const recorded = new Set<string>();
    const first = await vcs.events([REPO], STEADY);
    expect(keys(first)).toEqual(["comment:4400000001"]);
    first.events.forEach((e) => recorded.add(e.externalId));

    // The feed catches up: the comment is in both, and still one event.
    feed = [feedFixture("issue-comment-on-pull-request")];
    const second = await vcs.events([REPO], first.cursor);
    expect(keys(second)).toEqual(["comment:4400000001"]);
    second.events.forEach((e) => recorded.add(e.externalId));

    // Intake records by (source, external id): the comment is recorded once.
    expect([...recorded]).toEqual(["comment:4400000001"]);
  });

  it("reads the reviews of a pull request only when it moved, and not at all on a 304", async () => {
    let served = 0;
    const pulls = (r: { headers: Headers }) => {
      served++;
      return r.headers.get("if-none-match") === 'W/"p2"'
        ? { status: 304 }
        : { headers: served === 1 ? {} : { etag: 'W/"p2"' }, body: list("pulls") };
    };

    const { vcs, stub } = build([
      ...appRoutes(),
      feedRoute(() => []),
      { method: "GET", path: "/repos/acme/app/pulls", handler: pulls },
      ...listRoutes(ALL),
    ]);

    const reviewsRead = () => stub.called("GET", "/repos/acme/app/pulls/8/reviews").length;
    const first = await vcs.events([REPO], STEADY);
    expect(reviewsRead()).toBe(1);

    // #8 has not moved since its reviews were read.
    const second = await vcs.events([REPO], first.cursor);
    expect(reviewsRead()).toBe(1);
    expect(keys(second)).not.toContain("review:5600000005");

    const third = await vcs.events([REPO], second.cursor);
    expect(stub.called("GET", "/repos/acme/app/pulls").at(-1)!.headers.get("if-none-match")).toBe(
      'W/"p2"',
    );

    expect(reviewsRead()).toBe(1);
    expect(JSON.parse(third.cursor)["acme/app"].direct.reviewed).toEqual({
      "8": "2026-01-05T10:00:00Z",
    });
  });

  it("takes an edited comment as no news, and moves the cursor to the edit", async () => {
    const edited = {
      ...list("issue-comments")[0],
      created_at: "2026-01-05T09:00:00Z",
      updated_at: "2026-01-05T10:05:00Z",
    };

    // A comment without `updated_at` counts at its creation.
    const plain = { ...list("issue-comments")[0], id: 4400000005, updated_at: undefined };
    const { vcs } = build([
      ...appRoutes(),
      feedRoute(() => []),
      ...listRoutes({ comments: [edited, plain] }),
    ]);

    const page = await vcs.events([REPO], STEADY);
    expect(keys(page)).toEqual(["comment:4400000005"]);
    expect(JSON.parse(page.cursor)["acme/app"].direct.since).toBe("2026-01-05T10:05:00.000Z");
  });

  it("asks each list with its ETag and keeps the stored one when GitHub sends none", async () => {
    const comments = (r: { headers: Headers }) =>
      r.headers.get("if-none-match") === 'W/"c1"'
        ? { status: 304 }
        : { headers: { etag: 'W/"c1"' }, body: list("issue-comments") };

    const { vcs, stub } = build([
      ...appRoutes(),
      feedRoute(() => []),
      { method: "GET", path: "/repos/acme/app/issues/comments", handler: comments },
      ...listRoutes(),
    ]);

    const inline = "/repos/acme/app/pulls/comments";
    const cursor = cursorAt("2026-01-05T09:59:00Z", {
      since: "2026-01-05T09:59:00Z",
      etags: { [inline]: 'W/"old"' },
    });

    const first = await vcs.events([REPO], cursor);
    expect(keys(first)).toEqual(["comment:4400000001"]);
    expect(stub.called("GET", inline)[0]!.headers.get("if-none-match")).toBe('W/"old"');
    expect(JSON.parse(first.cursor)["acme/app"].direct.etags).toEqual({
      "/repos/acme/app/issues/comments": 'W/"c1"',
      [inline]: 'W/"old"',
    });

    const second = await vcs.events([REPO], first.cursor);
    expect(keys(second)).toEqual([]);
    expect(JSON.parse(second.cursor)["acme/app"].direct.since).toBe("2026-01-05T10:00:10.000Z");
  });

  it("logs how many requests a poll made, at debug", async () => {
    const debug = vi.spyOn(silentLogger, "debug");
    const { vcs } = build([...appRoutes(), feedRoute(() => []), ...listRoutes(ALL)]);
    await vcs.events([REPO], STEADY);
    // The feed, the two comment lists, the pulls list and the reviews of #8.
    expect(debug).toHaveBeenCalledWith("vcs: GitHub poll of 1 repositories made 5 requests", {
      repos: 1,
      requests: 5,
    });
  });
});

describe("the first poll with the direct lists", () => {
  const later = {
    ...feedFixture("issue-comment-on-pull-request"),
    id: "25000000010",
    created_at: "2026-01-05T10:00:30Z",
  };

  later.payload = { ...later.payload, comment: { ...later.payload["comment"], id: 4400000003 } };
  const laterComment = {
    ...list("issue-comments")[0],
    id: 4400000003,
    html_url: "https://github.com/acme/app/pull/8#issuecomment-4400000003",
    created_at: "2026-01-05T10:00:30Z",
    updated_at: "2026-01-05T10:00:30Z",
  };

  const routes = () => [
    ...appRoutes(),
    feedRoute(() => ({
      headers: { etag: 'W/"f2"' },
      body: [later, feedFixture("issue-comment-on-pull-request")],
    })),
    ...listRoutes({ comments: [list("issue-comments")[0], laterComment] }),
  ];

  // Written before the lists: the feed read up to 10:00:00, its comments recorded under feed event ids.
  const before = JSON.stringify({ "acme/app": { since: "2026-01-05T10:00:00Z", etag: 'W/"f1"' } });

  it("starts at the feed's time and does not report again what the feed already did", async () => {
    const { vcs, stub } = build(routes());
    const page = await vcs.events([REPO], before);
    expect(keys(page)).toEqual(["comment:4400000003"]);
    expect(
      stub.called("GET", "/repos/acme/app/events")[0]!.headers.get("if-none-match"),
    ).toBeNull();

    expect(stub.called("GET", "/repos/acme/app/issues/comments")[0]!.query.get("since")).toBe(
      "2026-01-05T10:00:00.001Z",
    );

    const entry = JSON.parse(page.cursor)["acme/app"];
    expect(entry).toMatchObject({
      etag: 'W/"f2"',
      since: "2026-01-05T10:00:30.000Z",
      seen: ["25000000010", "25000000009"],
      direct: { since: "2026-01-05T10:00:30.000Z", after: "2026-01-05T10:00:00.000Z" },
    });

    // The overlap of the next poll reaches back past 10:00:00, and still only the new comment comes back.
    const next = await vcs.events([REPO], page.cursor);
    expect(keys(next)).toEqual(["comment:4400000003"]);
  });

  it("forgets where the lists started once the overlap has moved past it", async () => {
    const { vcs } = build(routes());
    const cursor = cursorAt("2026-01-05T10:10:00Z", {
      since: "2026-01-05T10:10:00Z",
      after: "2026-01-05T10:00:00Z",
    });

    const page = await vcs.events([REPO], cursor);
    expect(JSON.parse(page.cursor)["acme/app"].direct).toEqual({
      since: "2026-01-05T10:10:00.000Z",
    });
  });

  it("reads no list on a baseline: what they hold is history", async () => {
    const { vcs, stub } = build(routes());
    for (const cursor of [undefined, "{}"]) {
      const page = await vcs.events([REPO], cursor);
      expect(JSON.parse(page.cursor)["acme/app"].direct).toEqual({
        since: "2026-01-01T00:00:00.000Z",
        after: "2026-01-01T00:00:00.000Z",
      });
    }

    expect(stub.called("GET", "/repos/acme/app/issues/comments")).toEqual([]);
  });
});
