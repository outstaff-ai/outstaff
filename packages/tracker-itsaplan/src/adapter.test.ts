import { PortError, silentLogger, type AdapterContext, type TeamConfig } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { buildFetch } from "./client.js";
import { errorCode, ItsaplanHttp } from "./http.js";
import { createItsaplanKnowledge } from "./knowledge.js";
import { knowledgeOptions, resolveConnection, trackerOptions, deriveApiUrl } from "./options.js";
import { createItsaplanTracker, eventType } from "./tracker.js";
import { secretMap, team } from "./testing/harness.js";
import { API_KEY, createStubFetch } from "./testing/http-stub.js";
import { createItsaplanFake } from "./testing/itsaplan-fake.js";

const trackerCtx = (fake: ReturnType<typeof createItsaplanFake>, t: TeamConfig = team) =>
  ({
    options: trackerOptions.parse({ url: "https://tracker.acme.example", project: "SHOP" }),
    secrets: secretMap({ ITSAPLAN_API_KEY: API_KEY }),
    team: t,
    log: silentLogger,
    fetch: fake.fetch,
    now: () => new Date("2026-01-01T00:00:00Z"),
  }) satisfies AdapterContext<ReturnType<typeof trackerOptions.parse>>;

const knowledgeCtx = (fake: ReturnType<typeof createItsaplanFake>) =>
  ({
    options: knowledgeOptions.parse({}),
    secrets: secretMap({ ITSAPLAN_API_KEY: API_KEY }),
    team,
    log: silentLogger,
    fetch: fake.fetch,
    now: () => new Date("2026-01-01T00:00:00Z"),
  }) satisfies AdapterContext<ReturnType<typeof knowledgeOptions.parse>>;

describe("options", () => {
  it("derives the API host from the web address", () => {
    expect(deriveApiUrl("https://tracker.acme.example/")).toBe("https://api.tracker.acme.example");
  });

  it("completes knowledge options from the tracker integration", () => {
    const conn = resolveConnection({ team }, knowledgeOptions.parse({}));
    expect(conn).toMatchObject({
      url: "https://tracker.acme.example",
      project: "SHOP",
      api_url: "https://api.tracker.acme.example",
    });
  });

  it("explains what is missing when nothing supplies url and project", () => {
    const bare = { integrations: {} } as unknown as TeamConfig;
    expect(() => resolveConnection({ team: bare }, knowledgeOptions.parse({}))).toThrow(PortError);
  });

  it("requires url and project on the tracker", () => {
    expect(trackerOptions.safeParse({ url: "https://tracker.acme.example" }).success).toBe(false);
  });
});

describe("status map", () => {
  it("maps canonical statuses through team.workflow.statuses and back", async () => {
    const fake = createItsaplanFake();
    const tracker = await createItsaplanTracker(trackerCtx(fake));
    const issue = await tracker.createIssue({ title: "A", body: "", status: "active" });
    expect(issue.status).toEqual({ name: "In Progress", canonical: "active" });
    expect(fake.state.issues[0]?.columnId).toBe(fake.state.columns[2]?.id);
  });

  it("defaults to Title Case names and falls back to the column kind", async () => {
    const fake = createItsaplanFake({
      columns: [
        { name: "Todo", stateType: "unstarted" },
        { name: "Doing", stateType: "started" },
        { name: "Shipped", stateType: "completed" },
      ],
    });

    const bare = { people: [], integrations: {} } as unknown as TeamConfig;
    const tracker = await createItsaplanTracker(trackerCtx(fake, bare));
    const created = await tracker.createIssue({ title: "A", body: "" });
    expect(created.status).toEqual({ name: "Todo", canonical: "ready" });
    expect((await tracker.transition(created.key, "done")).status).toEqual({
      name: "Shipped",
      canonical: "done",
    });

    await expect(tracker.transition(created.key, "canceled")).rejects.toMatchObject({
      code: "invalid",
    });
  });
});

describe("tracker", () => {
  it("sends the key and origin on every call and labels issues, creating missing labels", async () => {
    const fake = createItsaplanFake();
    const tracker = await createItsaplanTracker(trackerCtx(fake));
    const issue = await tracker.createIssue({ title: "L", body: "", labels: ["bug", "Bug"] });
    expect(issue.labels).toEqual(["bug"]);
    expect(fake.state.labels.map((l) => l.name)).toEqual(["bug"]);
    expect(fake.calls.every((c) => c.headers.get("x-api-key") === API_KEY)).toBe(true);
    expect(
      fake.calls.every((c) => c.headers.get("origin") === "https://tracker.acme.example"),
    ).toBe(true);
  });

  it("marks agents by team handle or the agents option, and accepts a username to assign", async () => {
    const fake = createItsaplanFake();
    const tracker = await createItsaplanTracker({
      ...trackerCtx(fake),
      options: trackerOptions.parse({
        url: "https://tracker.acme.example",
        project: "SHOP",
        agents: ["rio"],
      }),
    });

    const kinds = Object.fromEntries((await tracker.members()).map((m) => [m.username, m.kind]));
    expect(kinds).toEqual({ sam: "agent", rio: "agent" });
    const issue = await tracker.createIssue({ title: "Mine", body: "", assignee: "sam" });
    expect(issue.assignee).toMatchObject({ id: "u-sam", kind: "agent" });
    await expect(tracker.assign(issue.key, "nobody")).rejects.toMatchObject({ code: "not_found" });
  });

  it("builds issue links from the web address, or a template", async () => {
    const fake = createItsaplanFake();
    const tracker = await createItsaplanTracker(trackerCtx(fake));
    expect(tracker.links.issue("SHOP-7")).toBe("https://tracker.acme.example/SHOP-7");
    const custom = await createItsaplanTracker({
      ...trackerCtx(fake),
      options: trackerOptions.parse({
        url: "https://tracker.acme.example",
        project: "SHOP",
        issue_url: "{url}/p/{project}/issue/{key}",
      }),
    });

    expect(custom.links.issue("SHOP-7")).toBe("https://tracker.acme.example/p/SHOP/issue/SHOP-7");
  });

  it("rejects keys of another project and malformed keys", async () => {
    const tracker = await createItsaplanTracker(trackerCtx(createItsaplanFake()));
    await expect(tracker.getIssue("OTHER-1")).rejects.toMatchObject({ code: "not_found" });
    await expect(tracker.getIssue("nonsense!")).rejects.toMatchObject({ code: "invalid" });
  });

  it("turns activity into events, skips what the office does not act on, and never replays", async () => {
    const fake = createItsaplanFake();
    const tracker = await createItsaplanTracker(trackerCtx(fake));
    const issue = await tracker.createIssue({ title: "Flow", body: "" });
    await tracker.transition(issue.key, "review");
    await tracker.assign(issue.key, "u-sam");
    await tracker.comment(issue.key, "hello");
    await tracker.setLabels(issue.key, ["x"], []);

    const first = await tracker.events();
    expect(first.events.map((e) => e.type)).toEqual(["created", "moved", "assigned", "commented"]);
    expect(first.events[1]).toMatchObject({
      key: issue.key,
      actor: { id: "u-sam", kind: "agent" },
      data: { from: "Backlog", to: "Review" },
    });

    expect(first.events[3]?.data["body"]).toBe("hello");
    expect(new Set(first.events.map((e) => e.externalId)).size).toBe(4);
    expect((await tracker.events(first.cursor)).events).toEqual([]);
    await tracker.comment(issue.key, "more");
    const next = await tracker.events(first.cursor);
    expect(next.events.map((e) => e.data["body"])).toEqual(["more"]);
    await expect(tracker.events("not json")).rejects.toMatchObject({ code: "invalid" });
  });

  it("reads only the newest page when no cursor is given, with a cursor that represents now", async () => {
    const fake = createItsaplanFake();
    const tracker = await createItsaplanTracker(trackerCtx(fake));
    const issue = await tracker.createIssue({ title: "Busy", body: "" });
    for (let i = 0; i < 120; i++) {
      await tracker.comment(issue.key, `c${i}`);
    }

    const first = await tracker.events();
    expect(first.events).toHaveLength(100);
    expect(first.events.at(-1)?.data["body"]).toBe("c119");
    expect((await tracker.events(first.cursor)).events).toEqual([]);
    await tracker.comment(issue.key, "after");
    expect((await tracker.events(first.cursor)).events.map((e) => e.data["body"])).toEqual([
      "after",
    ]);
  });

  it("classifies activity actions", () => {
    const item = { id: 1, issueId: 1, issueSequence: 1, kind: "history", createdAt: "" };
    expect(eventType({ ...item, action: "created" })).toBe("created");
    expect(eventType({ ...item, action: "status" })).toBe("moved");
    expect(eventType({ ...item, action: "assignee" })).toBe("assigned");
    expect(eventType({ ...item, action: "priority" })).toBeUndefined();
    expect(eventType({ ...item, kind: "comment", action: null })).toBe("commented");
  });
});

describe("errors", () => {
  it("maps HTTP statuses to port error codes", () => {
    expect(
      Object.fromEntries(
        [400, 401, 403, 404, 409, 422, 429, 500, 503].map((s) => [s, errorCode(s)]),
      ),
    ).toEqual({
      400: "invalid",
      401: "forbidden",
      403: "forbidden",
      404: "not_found",
      409: "conflict",
      422: "invalid",
      429: "rate_limited",
      500: "unavailable",
      503: "unavailable",
    });
  });

  const call = (
    status: number,
    headers: Record<string, string> = {},
    body: unknown = { error: "nope", code: "x" },
  ) => {
    const stub = createStubFetch([
      { method: "GET", path: "/boom", handler: () => ({ status, headers, body }) },
    ]);

    return new ItsaplanHttp({
      fetch: stub.fetch,
      apiUrl: "https://api.tracker.acme.example",
      webUrl: "https://tracker.acme.example",
      apiKey: API_KEY,
    }).request("GET", "/boom");
  };

  it("keeps the platform's message and code", async () => {
    await expect(call(409, {}, { error: "WIP limit", code: "wip_limit_exceeded" })).rejects.toThrow(
      /wip_limit_exceeded: WIP limit/,
    );
  });

  it("reads retry-after on rate limits", async () => {
    await expect(call(429, { "retry-after": "7" })).rejects.toMatchObject({
      code: "rate_limited",
      retryAfterMs: 7000,
    });
  });

  it("maps network failures to unavailable", async () => {
    const http = new ItsaplanHttp({
      fetch: (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch,
      apiUrl: "https://api.tracker.acme.example",
      webUrl: "https://tracker.acme.example",
      apiKey: API_KEY,
    });

    await expect(http.request("GET", "/x")).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("custom CA", () => {
  it("builds a TLS-aware fetch from the PEM file", async () => {
    const conn = resolveConnection(
      { team },
      trackerOptions.parse({
        url: "https://tracker.acme.example",
        project: "SHOP",
        ca_file: "/etc/acme/ca.pem",
      }),
    );

    const marker = (() => Promise.resolve(new Response("{}"))) as unknown as typeof fetch;
    let seen = "";
    const f = await buildFetch(fetch, conn, {
      readFile: (p) => (p === "/etc/acme/ca.pem" ? "PEM TEXT" : ""),
      tlsFetch: async (ca) => {
        seen = ca;
        return marker;
      },
    });

    expect(f).toBe(marker);
    expect(seen).toBe("PEM TEXT");
  });

  it("leaves the injected fetch alone without ca_file and reports an unreadable file", async () => {
    const conn = resolveConnection(
      { team },
      trackerOptions.parse({ url: "https://tracker.acme.example", project: "SHOP" }),
    );

    expect(await buildFetch(fetch, conn)).toBe(fetch);
    await expect(
      buildFetch(
        fetch,
        { ...conn, ca_file: "/missing.pem" },
        {
          readFile: () => {
            throw new Error("ENOENT");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("really builds an undici dispatcher for a valid certificate path", async () => {
    const conn = resolveConnection(
      { team },
      trackerOptions.parse({ url: "https://tracker.acme.example", project: "SHOP" }),
    );

    const f = await buildFetch(fetch, { ...conn, ca_file: "x" }, { readFile: () => "not a pem" });
    expect(typeof f).toBe("function");
    expect(f).not.toBe(fetch);
  });
});

describe("knowledge", () => {
  it("resolves pages made in the web app by their titles, and keeps replies tied to their document", async () => {
    const fake = createItsaplanFake();
    const kb = await createItsaplanKnowledge(knowledgeCtx(fake));
    fake.state.docs.push(
      {
        id: 90,
        parentId: null,
        title: "Handbook",
        metadata: {},
        version: 1,
        content: "",
        contentJson: null,
        createdAt: "",
        updatedAt: "",
      },
      {
        id: 91,
        parentId: 90,
        title: "Onboarding",
        metadata: {},
        version: 3,
        content: "Welcome aboard, friend",
        contentJson: null,
        createdAt: "",
        updatedAt: "",
      },
    );

    const doc = await kb.get("handbook/onboarding");
    expect(doc).toMatchObject({ id: "91", path: "Handbook/Onboarding", version: "3" });
    // no editor JSON yet: the first comment writes it, then anchors
    const c = await kb.comment(doc.id, { body: "nice", anchorText: "aboard" });
    expect(c.id).toMatch(/^91:/);
    expect(fake.state.docs.find((d) => d.id === 91)?.contentJson).not.toBeNull();
    const r = await kb.reply(c.id, "thanks");
    expect(r.parentId).toBe(c.id);
    await kb.resolve(c.id);
    expect((await kb.comments(doc.id)).find((x) => x.id === c.id)?.resolved).toBe(true);
  });

  it("creates parent pages for a nested path and stores the path", async () => {
    const fake = createItsaplanFake();
    const kb = await createItsaplanKnowledge(knowledgeCtx(fake));
    await kb.create({ path: "eng/runbooks/deploy", title: "Deploy", body: "# Steps\n\n- one" });
    expect(fake.state.docs.map((d) => [d.title, d.parentId])).toEqual([
      ["eng", null],
      ["runbooks", 1],
      ["Deploy", 2],
    ]);

    expect((await kb.get("eng/runbooks")).title).toBe("runbooks");
    expect(fake.state.docs[2]?.contentJson?.content?.[0]?.type).toBe("heading");
    expect(kb.links.doc("3")).toBe("https://tracker.acme.example/SHOP/docs/3");
  });

  it("updates against the current version when no baseVersion is given and writes both bodies", async () => {
    const fake = createItsaplanFake();
    const kb = await createItsaplanKnowledge(knowledgeCtx(fake));
    const doc = await kb.create({ path: "a", title: "A", body: "one" });
    const next = await kb.update(doc.id, { body: "two" });
    expect(next.version).toBe("2");
    expect(fake.state.docs[0]?.contentJson?.content?.[0]?.content?.[0]?.text).toBe("two");
  });

  it("anchors a comment on the first text when no anchorText is given, and refuses unknown text", async () => {
    const fake = createItsaplanFake();
    const kb = await createItsaplanKnowledge(knowledgeCtx(fake));
    const doc = await kb.create({ path: "n", title: "N", body: "First line\n\nSecond" });
    expect((await kb.comment(doc.id, { body: "hm" })).anchorText).toBe("First line");
    await expect(kb.comment(doc.id, { body: "x", anchorText: "absent" })).rejects.toMatchObject({
      code: "invalid",
    });

    const empty = await kb.create({ path: "e", title: "E", body: "" });
    await expect(kb.comment(empty.id, { body: "x" })).rejects.toMatchObject({ code: "invalid" });
  });
});
