import { silentLogger, type AdapterContext } from "@outstaff/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trackerOptions } from "../options.js";
import { secretMap, team } from "../testing/harness.js";
import { API_KEY, createStubFetch, type Route, type StubRequest } from "../testing/http-stub.js";
import { createItsaplanTracker, eventType } from "../tracker.js";

const setup = () => ({
  project: { id: 1, key: "SHOP", ref: "acme.SHOP", name: "Shop", teamRef: "acme" },
  columns: [{ id: 10, name: "Backlog", stateType: "backlog", position: 0 }],
  labels: [{ id: 5, name: "bug" }],
  assignees: [{ userId: "u-sam", name: "Sam Duarte", username: "sam" }],
});

const issue = (over: Record<string, unknown> = {}) => ({
  id: 1001,
  sequenceNumber: 1,
  identifier: "SHOP-1",
  title: "First",
  columnId: 10,
  updatedAt: "2026-01-01T00:00:00Z",
  ...over,
});

/** A tracker over hand-written routes; the project setup and issue SHOP-1 are always served. */
async function trackerOver(routes: Route[]) {
  const stub = createStubFetch([
    { method: "GET", path: "/projects/SHOP", handler: () => setup() },
    { method: "GET", path: "/projects/SHOP/issues/1", handler: () => issue() },
    ...routes,
  ]);

  const ctx = {
    options: trackerOptions.parse({ url: "https://tracker.acme.example", project: "SHOP" }),
    secrets: secretMap({ ITSAPLAN_API_KEY: API_KEY }),
    team,
    log: silentLogger,
    fetch: stub.fetch,
    now: () => new Date("2026-01-01T00:00:00Z"),
  } satisfies AdapterContext<ReturnType<typeof trackerOptions.parse>>;

  return { tracker: await createItsaplanTracker(ctx), stub };
}

const route = (method: string, path: string, handler: Route["handler"]): Route => ({
  method,
  path,
  handler,
});

describe("issue mapping", () => {
  it("reads a missing description as empty and missing labels as none", async () => {
    const { tracker } = await trackerOver([
      route("GET", "/projects/SHOP/issues/2", () => issue({ id: 1002, description: null })),
    ]);

    expect(await tracker.getIssue("SHOP-2")).toMatchObject({ body: "", labels: [] });
  });

  it("drops label ids the project does not know", async () => {
    const { tracker } = await trackerOver([]);
    // SHOP-1 has no labelIds at all; one unknown id next to a known one
    const { tracker: withLabels } = await trackerOver([
      route("GET", "/projects/SHOP/issues/3", () => issue({ id: 1003, labelIds: [5, 99] })),
    ]);

    expect((await tracker.getIssue("SHOP-1")).labels).toEqual([]);
    expect((await withLabels.getIssue("SHOP-3")).labels).toEqual(["bug"]);
  });
});

describe("setLabels", () => {
  it("ignores a label to remove that does not exist, without creating it", async () => {
    const { tracker, stub } = await trackerOver([
      route("PATCH", "/issues/1001", (req: StubRequest) => issue({ labelIds: req.json.labelIds })),
    ]);

    await tracker.setLabels("SHOP-1", [], ["ghost"]);
    expect(stub.called("PATCH", "/issues/1001")[0]?.json).toEqual({ labelIds: [] });
    expect(stub.called("POST", "/projects/SHOP/labels")).toHaveLength(0);
  });
});

describe("listComments", () => {
  const comment = (id: number, createdAt: string, extra: Record<string, unknown> = {}) => ({
    id,
    kind: "comment",
    actorUserId: "u-sam",
    body: `c${id}`,
    createdAt,
    ...extra,
  });

  it("follows the feed cursor across pages and orders by time, then id", async () => {
    const seen: (string | null)[] = [];
    const { tracker } = await trackerOver([
      route("GET", "/issues/1001/feed", (req) => {
        seen.push(req.query.get("cursor"));
        return req.query.get("cursor") === null
          ? {
              items: [comment(9, "2026-01-02T00:00:00Z"), comment(8, "2026-01-02T00:00:00Z")],
              nextCursor: { ts: "2026-01-02T00:00:00Z", id: 8 },
            }
          : {
              items: [
                comment(7, "2026-01-01T00:00:00Z", { body: null }),
                { id: 6, kind: "history", createdAt: "2026-01-01T00:00:00Z" },
              ],
              nextCursor: null,
            };
      }),
    ]);

    const comments = await tracker.listComments("SHOP-1");
    expect(comments.map((c) => [c.id, c.body])).toEqual([
      ["7", ""],
      ["8", "c8"],
      ["9", "c9"],
    ]);

    expect(seen).toEqual([null, JSON.stringify({ ts: "2026-01-02T00:00:00Z", id: 8 })]);
  });

  it("stops when a page comes back empty even though it names a next cursor", async () => {
    let calls = 0;
    const { tracker } = await trackerOver([
      route("GET", "/issues/1001/feed", () => {
        calls += 1;
        return { items: [], nextCursor: { ts: "2026-01-02T00:00:00Z", id: 1 } };
      }),
    ]);

    expect(await tracker.listComments("SHOP-1")).toEqual([]);
    expect(calls).toBe(1);
  });
});

describe("attachments", () => {
  it("accepts every field spelling the API uses and skips entries without an id", async () => {
    const { tracker } = await trackerOver([
      route("GET", "/issues/1001/attachments", () => ({
        items: [
          { publicId: "p1", filename: "a.png", mimeType: "image/png", size: 12 },
          { id: 7, name: "b.txt", contentType: "text/plain" },
          { id: "x9" },
          { filename: "orphan.txt" },
        ],
      })),
    ]);

    expect(await tracker.attachments!("SHOP-1")).toEqual([
      { id: "p1", name: "a.png", mimetype: "image/png", size: 12 },
      { id: "7", name: "b.txt", mimetype: "text/plain", size: 0 },
      { id: "x9", name: "x9", mimetype: "application/octet-stream", size: 0 },
    ]);
  });

  it("reads a bare array answer", async () => {
    const { tracker } = await trackerOver([
      route("GET", "/issues/1001/attachments", () => [{ publicId: "p2" }]),
    ]);

    expect(await tracker.attachments!("SHOP-1")).toEqual([
      { id: "p2", name: "p2", mimetype: "application/octet-stream", size: 0 },
    ]);
  });
});

describe("events", () => {
  afterEach(() => void vi.useRealTimers());

  const entry = (id: number, createdAt: string, extra: Record<string, unknown> = {}) => ({
    id,
    issueId: 1001,
    issueSequence: 1,
    kind: "history",
    actorUserId: "u-sam",
    createdAt,
    ...extra,
  });

  it("starts at the present when the activity feed is empty", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-04T05:06:07Z"));
    const { tracker } = await trackerOver([
      route("GET", "/projects/SHOP/analytics/activity", () => ({ items: [] })),
    ]);

    const page = await tracker.events(undefined);
    expect(page.events).toEqual([]);
    expect(JSON.parse(page.cursor)).toEqual({ since: "2026-03-04T05:06:07.000Z" });
  });

  it("skips activity that is not an office event and orders the rest by time, then id", async () => {
    const at = "2026-01-01T00:00:10Z";
    const { tracker } = await trackerOver([
      route("GET", "/projects/SHOP/analytics/activity", () => ({
        items: [
          entry(4, at, { action: "created" }),
          entry(3, at, { action: "label_added" }),
          entry(2, at, { action: null }),
          entry(1, at, { action: "assigned" }),
        ],
      })),
    ]);

    const page = await tracker.events(JSON.stringify({ since: "2026-01-01T00:00:00Z" }));
    expect(page.events.map((e) => [e.externalId, e.type])).toEqual([
      ["itsaplan:1", "assigned"],
      ["itsaplan:4", "created"],
    ]);
  });

  it("classifies activity by kind and action", () => {
    const base = { id: 1, issueId: 1, issueSequence: 1, createdAt: "2026-01-01T00:00:00Z" };
    expect(eventType({ ...base, kind: "comment" })).toBe("commented");
    expect(eventType({ ...base, kind: "history", action: "CREATE" })).toBe("created");
    expect(eventType({ ...base, kind: "history", action: "reassigned" })).toBe("assigned");
    expect(eventType({ ...base, kind: "history", action: "column_changed" })).toBe("moved");
    expect(eventType({ ...base, kind: "history", action: "label_added" })).toBeUndefined();
    expect(eventType({ ...base, kind: "history" })).toBeUndefined();
  });
});
