import { silentLogger, type AdapterContext } from "@outstaff/core";
import { knowledgeOptions } from "@outstaff/integration.tracker.itsaplan";
import { describe, expect, it } from "vitest";
import {
  API_KEY,
  createItsaplanFake,
  createStubFetch,
  type Route,
  secretMap,
  team,
} from "@outstaff/testing.itsaplan";
import { itsaplanKnowledge } from "../index.js";
import { createItsaplanKnowledge } from "../knowledge.js";
import { mdToDoc } from "../markdown.js";

const PROJECT = {
  project: { id: 1, key: "SHOP", ref: "acme.SHOP", name: "Shop", teamRef: "acme" },
  columns: [],
  labels: [],
  assignees: [{ userId: "u-sam", name: "Sam Duarte", username: "sam" }],
};

const summary = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  title: `Doc ${id}`,
  version: 1,
  updatedAt: "2026-01-01T00:00:00Z",
  ...over,
});

const route = (method: string, path: string, handler: Route["handler"]): Route => ({
  method,
  path,
  handler,
});

const DOCS = "/projects/SHOP/documents";

async function knowledgeOver(routes: Route[]) {
  const stub = createStubFetch([route("GET", "/projects/SHOP", () => PROJECT), ...routes]);
  const ctx = {
    options: knowledgeOptions.parse({}),
    secrets: secretMap({ ITSAPLAN_API_KEY: API_KEY }),
    team,
    log: silentLogger,
    fetch: stub.fetch,
    now: () => new Date("2026-01-01T00:00:00Z"),
  } satisfies AdapterContext<ReturnType<typeof knowledgeOptions.parse>>;

  return { kb: await createItsaplanKnowledge(ctx), stub };
}

describe("reading pages", () => {
  it("stops following parents after 50 levels, so a cycle cannot hang the path", async () => {
    const { kb } = await knowledgeOver([
      route("GET", DOCS, () => [summary(1, { parentId: 2 }), summary(2, { parentId: 1 })]),
      route("GET", `${DOCS}/1`, () => summary(1, { parentId: 2, content: null })),
    ]);

    const doc = await kb.get("1");
    expect(doc.path.split("/")).toHaveLength(51);
    expect(doc.body).toBe("");
  });

  it("names the path of a hit the page list did not carry after its own title", async () => {
    const { kb } = await knowledgeOver([
      route("GET", DOCS, (req) => (req.query.get("q") ? [summary(3, { title: "Gamma" })] : [])),
      route("GET", `${DOCS}/3`, () => summary(3, { title: "Gamma", content: "g" })),
    ]);

    const [hit] = await kb.search("gam");
    expect(hit).toMatchObject({ id: "3", path: "Gamma", body: "g" });
  });
});

describe("writing pages", () => {
  it("refuses an empty path and a title with a slash before calling the API", async () => {
    const { kb, stub } = await knowledgeOver([route("GET", DOCS, () => [])]);
    await expect(kb.create({ path: " / ", title: "T", body: "" })).rejects.toMatchObject({
      code: "invalid",
    });

    await expect(kb.create({ path: "a", title: "x/y", body: "" })).rejects.toMatchObject({
      code: "invalid",
    });

    expect(stub.calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("refuses a title with a slash on update", async () => {
    const { kb, stub } = await knowledgeOver([]);
    await expect(kb.update("7", { title: "a/b", baseVersion: "2" })).rejects.toMatchObject({
      code: "invalid",
      message: "A title cannot contain '/'.",
    });

    expect(stub.calls.filter((c) => c.method === "PATCH")).toEqual([]);
  });

  it("sends only the title with the given base version, without reading the page first", async () => {
    const { kb, stub } = await knowledgeOver([
      route("GET", DOCS, () => [summary(7, { title: "Renamed", metadata: { path: "Renamed" } })]),
      route("PATCH", `${DOCS}/7`, () =>
        summary(7, { title: "Renamed", version: 5, metadata: { path: "Renamed" } }),
      ),
    ]);

    const updated = await kb.update("7", { title: "Renamed", baseVersion: "4" });
    expect(stub.called("PATCH", `${DOCS}/7`)[0]?.json).toEqual({ version: 4, title: "Renamed" });
    expect(stub.called("GET", `${DOCS}/7`)).toHaveLength(0);
    expect(updated).toMatchObject({ title: "Renamed", version: "5", path: "Renamed" });
  });
});

describe("comments", () => {
  it("shows a comment without author, quote or parent as unknown, unanchored and open", async () => {
    const { kb } = await knowledgeOver([
      route("GET", `${DOCS}/7/comments`, () => [
        { id: "c1", body: "hi", authorName: null, quote: null, createdAt: "2026-01-01T00:00:00Z" },
      ]),
    ]);

    expect(await kb.comments("7")).toEqual([
      {
        id: "7:c1",
        docId: "7",
        author: "unknown",
        body: "hi",
        resolved: false,
        at: "2026-01-01T00:00:00Z",
      },
    ]);
  });

  it("fails when a created comment cannot be read back", async () => {
    const { kb } = await knowledgeOver([
      route("GET", `${DOCS}/7`, () =>
        summary(7, { content: "hello", contentJson: mdToDoc("hello") }),
      ),
      route("POST", `${DOCS}/7/comments`, () => ({ id: "c9" })),
      route("GET", `${DOCS}/7/comments`, () => []),
    ]);

    await expect(kb.comment("7", { body: "hi" })).rejects.toMatchObject({
      code: "unavailable",
      message: "Comment c9 was created but could not be read back.",
    });
  });

  it("stores the editor JSON of an empty page before commenting, and finds nothing to anchor to", async () => {
    const { kb, stub } = await knowledgeOver([
      route("GET", `${DOCS}/7`, () => summary(7, { content: null, contentJson: null })),
      route("PATCH", `${DOCS}/7`, () =>
        summary(7, { version: 2, content: "", contentJson: mdToDoc("") }),
      ),
    ]);

    await expect(kb.comment("7", { body: "hi" })).rejects.toMatchObject({ code: "invalid" });
    expect(stub.called("PATCH", `${DOCS}/7`)[0]?.json).toEqual({
      version: 1,
      content: "",
      contentJson: mdToDoc(""),
    });
  });
});

describe("events", () => {
  const stamp = "2026-01-01T00:00:00Z";
  const note = (id: string, createdAt = stamp) => ({ id, body: `note ${id}`, createdAt });

  it("skips documents that are gone or closed and starts at the present when nothing else is read", async () => {
    const { kb } = await knowledgeOver([
      route("GET", `${DOCS}/1/comments`, () => ({ status: 404, body: { error: "gone" } })),
      route("GET", `${DOCS}/2/comments`, () => ({ status: 403, body: { error: "closed" } })),
    ]);

    const page = await kb.events(["1", "2"], undefined);
    expect(page.events).toEqual([]);
    expect(JSON.parse(page.cursor)).toEqual({ since: "2026-01-01T00:00:00.000Z" });
  });

  it("surfaces a server failure so the next poll retries it", async () => {
    const { kb } = await knowledgeOver([
      route("GET", `${DOCS}/3/comments`, () => ({ status: 500, body: { error: "boom" } })),
    ]);

    await expect(kb.events(["3"], undefined)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("surfaces an answer it cannot read instead of treating the document as quiet", async () => {
    const { kb } = await knowledgeOver([route("GET", `${DOCS}/3/comments`, () => ({ items: [] }))]);
    await expect(kb.events(["3"], undefined)).rejects.toBeInstanceOf(TypeError);
  });

  it("orders comments made at the same time by their id", async () => {
    const { kb } = await knowledgeOver([
      route("GET", `${DOCS}/4`, () => summary(4, { title: "Plan" })),
      route("GET", `${DOCS}/4/comments`, () => [note("b"), note("a")]),
    ]);

    const page = await kb.events(["4"], undefined);
    expect(page.events.map((e) => e.data["commentId"])).toEqual(["4:a", "4:b"]);
    expect(page.events.every((e) => e.title === "Plan")).toBe(true);
  });
});

describe("itsaplanKnowledge", () => {
  it("creates a knowledge base on the configured instance", async () => {
    const fake = createItsaplanFake();
    const kb = await itsaplanKnowledge.create({
      options: itsaplanKnowledge.options.parse({}),
      secrets: secretMap({ ITSAPLAN_API_KEY: API_KEY }),
      team,
      log: silentLogger,
      fetch: fake.fetch,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    const made = await kb.create({ path: "Guides/Start", title: "Start", body: "hello" });
    expect(made).toMatchObject({ path: "Guides/Start", url: expect.stringContaining("/docs/") });
    expect((await kb.get("Guides/Start")).body).toBe("hello");
  });
});
