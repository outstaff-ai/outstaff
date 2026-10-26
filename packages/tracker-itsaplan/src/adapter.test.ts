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

  it("uploads a file to the issue as multipart, by the issue's id", async () => {
    const fake = createItsaplanFake();
    const tracker = await createItsaplanTracker(trackerCtx(fake));
    const issue = await tracker.createIssue({ title: "With a picture", body: "" });
    await tracker.attach!(issue.key, {
      name: "screen.png",
      mimetype: "image/png",
      data: new Uint8Array([137, 80, 78, 71]),
    });

    const [upload] = fake.state.attachments;
    expect(upload).toMatchObject({
      issueId: Number(issue.id),
      name: "screen.png",
      mimetype: "image/png",
    });

    expect([...upload!.data]).toEqual([137, 80, 78, 71]);
    const call = fake.called("POST", `/issues/${issue.id}/attachments`)[0]!;
    // No content type of our own: fetch sets multipart with its boundary.
    expect(call.form).toBeInstanceOf(FormData);
    expect(call.headers.get("content-type")).toBeNull();
    expect(call.headers.get("x-api-key")).toBe(API_KEY);
  });

  it("lists the files of an issue and downloads them by their public id", async () => {
    const fake = createItsaplanFake();
    const tracker = await createItsaplanTracker(trackerCtx(fake));
    const issue = await tracker.createIssue({ title: "Has a picture", body: "" });
    const other = await tracker.createIssue({ title: "Has none", body: "" });
    await tracker.attach!(issue.key, {
      name: "bug.png",
      mimetype: "image/png",
      data: new Uint8Array([1, 2, 3]),
    });

    const listed = await tracker.attachments!(issue.key);
    expect(listed).toEqual([{ id: "pub-1", name: "bug.png", mimetype: "image/png", size: 3 }]);
    expect(await tracker.attachments!(other.key)).toEqual([]);
    expect([...(await tracker.download!(listed[0]!))]).toEqual([1, 2, 3]);
    expect(fake.called("GET", "/attachments/pub-1/raw")).toHaveLength(1);
    await expect(tracker.download!({ ...listed[0]!, id: "pub-9" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("names the missing issue when an upload targets an unknown key", async () => {
    const fake = createItsaplanFake();
    const tracker = await createItsaplanTracker(trackerCtx(fake));
    await expect(
      tracker.attach!("SHOP-404", {
        name: "a.txt",
        mimetype: "text/plain",
        data: new Uint8Array(),
      }),
    ).rejects.toMatchObject({ code: "not_found" });
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

  it("builds issue links from the workspace the API names, or a template", async () => {
    const fake = createItsaplanFake();
    const tracker = await createItsaplanTracker(trackerCtx(fake));
    await tracker.members(); // reads the project, which names the workspace
    expect(tracker.links.issue("SHOP-7")).toBe("https://tracker.acme.example/acme/issue/SHOP-7");
    const custom = await createItsaplanTracker({
      ...trackerCtx(fake),
      options: trackerOptions.parse({
        url: "https://tracker.acme.example",
        project: "SHOP",
        issue_url: "{url}/p/{project}/issue/{key}",
      }),
    });

    expect(custom.links.issue("SHOP-7")).toBe("https://tracker.acme.example/p/SHOP/issue/SHOP-7");

    const named = await createItsaplanTracker({
      ...trackerCtx(createItsaplanFake({ teamRef: "globex" })),
      options: trackerOptions.parse({
        url: "https://tracker.acme.example",
        project: "SHOP",
        issue_url: "{url}/w/{workspace}/{key}",
      }),
    });

    await named.members();
    expect(named.links.issue("SHOP-7")).toBe("https://tracker.acme.example/w/globex/SHOP-7");
  });

  it("takes the workspace from the project and lets doc_url override the default", async () => {
    const fake = createItsaplanFake({ teamRef: "globex" });
    const kb = await createItsaplanKnowledge(knowledgeCtx(fake));
    await kb.search("x");
    expect(kb.links.doc("3")).toBe("https://tracker.acme.example/globex/SHOP/docs/3");
    const custom = await createItsaplanKnowledge({
      ...knowledgeCtx(fake),
      options: knowledgeOptions.parse({ doc_url: "{url}/{workspace}/d/{id}" }),
    });

    await custom.search("x");
    expect(custom.links.doc("3")).toBe("https://tracker.acme.example/globex/d/3");
  });

  it("links a comment to its parent unless a comment template is set", async () => {
    const fake = createItsaplanFake();
    const tracker = await createItsaplanTracker(trackerCtx(fake));
    const issue = await tracker.createIssue({ title: "T", body: "" });
    expect(tracker.links.comment!("SHOP-7", "41")).toBe(
      "https://tracker.acme.example/acme/issue/SHOP-7",
    );

    const made = await tracker.comment(issue.key, "hi");
    expect(made.url).toBe(tracker.links.issue(issue.key));

    const custom = await createItsaplanTracker({
      ...trackerCtx(fake),
      options: trackerOptions.parse({
        url: "https://tracker.acme.example",
        project: "SHOP",
        issue_comment_url: "{url}/{workspace}/issue/{key}?comment={commentId}",
      }),
    });

    const again = await custom.comment(issue.key, "hi again");
    expect(again.url).toBe(
      `https://tracker.acme.example/acme/issue/${issue.key}?comment=${again.id}`,
    );

    expect((await custom.listComments(issue.key)).map((c) => c.url)).toContain(again.url);

    const kb = await createItsaplanKnowledge({
      ...knowledgeCtx(fake),
      options: knowledgeOptions.parse({
        doc_comment_url: "{url}/{workspace}/{project}/docs/{id}#c-{commentId}",
      }),
    });

    await kb.search("");
    expect(kb.links.comment!("3", "3:9")).toBe("https://tracker.acme.example/acme/SHOP/docs/3#c-9");

    const plain = await createItsaplanKnowledge(knowledgeCtx(fake));
    await plain.search("");
    expect(plain.links.comment!("3", "3:9")).toBe(plain.links.doc("3"));
  });

  it("starts with an unreachable API and resolves the workspace once it answers", async () => {
    const fake = createItsaplanFake({ teamRef: "globex" });
    let up = false;
    let t = Date.parse("2026-01-01T00:00:00Z");
    const flaky: typeof fake.fetch = async (input, init) => {
      if (!up) {
        throw new TypeError("fetch failed");
      }

      return fake.fetch(input, init);
    };

    const warnings: string[] = [];
    const ctx = {
      ...trackerCtx(fake),
      fetch: flaky,
      now: () => new Date(t),
      log: { ...silentLogger, warn: (m: string) => warnings.push(m) },
    };

    const tracker = await createItsaplanTracker(ctx);
    expect(tracker.links.issue("SHOP-7")).toBe("https://tracker.acme.example/SHOP-7");
    expect(tracker.links.issue("SHOP-8")).toBe("https://tracker.acme.example/SHOP-8");
    expect(warnings).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 0)); // the background attempt fails; it backs off

    up = true;
    await new Promise((r) => setTimeout(r, 0));
    expect(tracker.links.issue("SHOP-7")).toBe("https://tracker.acme.example/SHOP-7");

    t += 6_000; // past the first backoff
    await tracker.getIssue((await tracker.createIssue({ title: "A", body: "" })).key);
    expect(tracker.links.issue("SHOP-7")).toBe("https://tracker.acme.example/globex/issue/SHOP-7");
  });

  it("keeps explicit templates working while the workspace is unknown", async () => {
    const fake = createItsaplanFake();
    const down: typeof fake.fetch = async () => {
      throw new TypeError("fetch failed");
    };

    const tracker = await createItsaplanTracker({
      ...trackerCtx(fake),
      fetch: down,
      options: trackerOptions.parse({
        url: "https://tracker.acme.example",
        project: "SHOP",
        issue_url: "{url}/p/{project}/issue/{key}",
      }),
    });

    expect(tracker.links.issue("SHOP-7")).toBe("https://tracker.acme.example/p/SHOP/issue/SHOP-7");
  });

  it("builds document links without the workspace until a read resolves it", async () => {
    const fake = createItsaplanFake({ teamRef: "globex" });
    let up = false;
    const flaky: typeof fake.fetch = async (input, init) => {
      if (!up) {
        throw new TypeError("fetch failed");
      }

      return fake.fetch(input, init);
    };

    let t = Date.parse("2026-01-01T00:00:00Z");
    const kb = await createItsaplanKnowledge({
      ...knowledgeCtx(fake),
      fetch: flaky,
      now: () => new Date(t),
    });

    expect(kb.links.doc("3")).toBe("https://tracker.acme.example/SHOP/docs/3");
    await new Promise((r) => setTimeout(r, 0));
    up = true;
    t += 6_000;
    await kb.search("x");
    expect(kb.links.doc("3")).toBe("https://tracker.acme.example/globex/SHOP/docs/3");
  });

  it("rejects keys of another project and malformed keys", async () => {
    const tracker = await createItsaplanTracker(trackerCtx(createItsaplanFake()));
    await expect(tracker.getIssue("OTHER-1")).rejects.toMatchObject({ code: "not_found" });
    await expect(tracker.getIssue("nonsense!")).rejects.toMatchObject({ code: "invalid" });
  });

  it("maps the one created item of an issue made with an assignee to ticket.created, which resolves to that assignee", async () => {
    const fake = createItsaplanFake();
    const tracker = await createItsaplanTracker(trackerCtx(fake));
    const issue = await tracker.createIssue({
      title: "Born assigned",
      body: "",
      assignee: "u-sam",
    });

    const { events } = await tracker.events();
    expect(events.map((e) => e.type)).toEqual(["created"]);
    expect(events[0]).toMatchObject({ key: issue.key });
    expect((await tracker.getIssue(issue.key)).assignee).toMatchObject({
      id: "u-sam",
      kind: "agent",
    });
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
    expect(first.events[3]?.data).toMatchObject({
      commentId: expect.any(String),
      url: expect.stringMatching(/#comment-\d+$/),
    });

    expect(new Set(first.events.map((e) => e.externalId)).size).toBe(4);
    // The overlap re-reads recent activity; intake de-duplicates by external id.
    const seen = new Set(first.events.map((e) => e.externalId));
    const replay = await tracker.events(first.cursor);
    expect(replay.events.filter((e) => !seen.has(e.externalId))).toEqual([]);
    await tracker.comment(issue.key, "more");
    const next = await tracker.events(first.cursor);
    expect(next.events.filter((e) => !seen.has(e.externalId)).map((e) => e.data["body"])).toEqual([
      "more",
    ]);

    await expect(tracker.events("not json")).rejects.toMatchObject({ code: "invalid" });
  });

  it("with no cursor reads what is within the overlap of now, and hands none of it back as news later", async () => {
    const fake = createItsaplanFake();
    const tracker = await createItsaplanTracker(trackerCtx(fake));
    const issue = await tracker.createIssue({ title: "Busy", body: "" });
    for (let i = 0; i < 120; i++) {
      await tracker.comment(issue.key, `c${i}`);
    }

    const first = await tracker.events();
    expect(first.events).toHaveLength(121);
    expect(first.events.at(-1)?.data["body"]).toBe("c119");
    const seen = new Set(first.events.map((e) => e.externalId));
    const unseen = async () =>
      (await tracker.events(first.cursor)).events.filter((e) => !seen.has(e.externalId));

    expect(await unseen()).toEqual([]);
    await tracker.comment(issue.key, "after");
    expect((await unseen()).map((e) => e.data["body"])).toEqual(["after"]);
  });

  it("tracks activity by time: a later item with a lower id is not skipped, an old cursor shape baselines", async () => {
    const fake = createItsaplanFake();
    const item = (id: number, body: string, createdAt: string) => ({
      id,
      issueId: 1,
      issueSequence: 1,
      kind: "comment",
      body,
      createdAt,
    });

    // Newest first by time, but ids are not in time order.
    const feed = [
      item(100, "late", "2026-01-01T11:00:00Z"),
      item(900, "early", "2026-01-01T10:00:00Z"),
    ];

    const fetch: typeof fake.fetch = async (url, init) =>
      String(url).includes("/analytics/activity")
        ? new Response(JSON.stringify({ items: feed }), {
            headers: { "content-type": "application/json" },
          })
        : fake.fetch(url, init);

    const tracker = await createItsaplanTracker({ ...trackerCtx(fake), fetch });
    const cursor = JSON.stringify({ since: "2026-01-01T10:30:00Z" });
    const page = await tracker.events(cursor);
    expect(page.events.map((e) => e.data["body"])).toEqual(["late"]);
    expect(JSON.parse(page.cursor)).toEqual({ since: "2026-01-01T11:00:00.000Z" });

    // Never backwards, and the overlap window re-returns what is close to it.
    const ahead = await tracker.events(JSON.stringify({ since: "2026-01-01T11:03:00Z" }));
    expect(ahead.events.map((e) => e.data["body"])).toEqual(["late"]);
    expect(JSON.parse(ahead.cursor)).toEqual({ since: "2026-01-01T11:03:00.000Z" });

    // An id-based cursor from before is no position: baseline, emit nothing.
    const old = await tracker.events(JSON.stringify({ id: 5 }));
    expect(old.events).toEqual([]);
    expect(JSON.parse(old.cursor)).toMatchObject({ since: "2026-01-01T11:00:00.000Z" });
    // ...and what the baseline read is not returned again.
    expect((await tracker.events(old.cursor)).events).toEqual([]);
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
    await kb.search("x");
    expect(kb.links.doc("3")).toBe("https://tracker.acme.example/acme/SHOP/docs/3");
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

describe("knowledge events", () => {
  const setup = async () => {
    const fake = createItsaplanFake();
    const kb = await createItsaplanKnowledge(knowledgeCtx(fake));
    const doc = await kb.create({
      path: "design/cart",
      title: "Cart design",
      body: "Keep the cart\n\nin the session",
    });

    return { fake, kb, doc };
  };

  it("reads the comments of the named documents, oldest first, with the author's identity and the anchor", async () => {
    const { kb, doc } = await setup();
    const other = await kb.create({ path: "design/other", title: "Other", body: "Elsewhere" });
    const base = await kb.events([doc.id, other.id]);
    const c = await kb.comment(doc.id, { body: "why a session?", anchorText: "the cart" });
    const r = await kb.reply(c.id, "so it survives a reload");
    await kb.comment(other.id, { body: "not asked for", anchorText: "Elsewhere" });

    const page = await kb.events([doc.id], base.cursor);
    expect(page.events.map((e) => e.data.body)).toEqual([
      "why a session?",
      "so it survives a reload",
    ]);

    expect(page.events[0]).toMatchObject({
      externalId: expect.stringContaining(c.id),
      type: "commented",
      doc: doc.id,
      title: "Cart design",
      url: doc.url,
      actor: { id: "u-sam", kind: "agent" },
      data: { commentId: c.id, anchorText: "the cart" },
    });

    expect(page.events[1]?.data.parentId).toBe(c.id);
    expect(r.id).toBe(page.events[1]?.data.commentId);
    expect(page.events.every((e) => e.doc === doc.id)).toBe(true);
  });

  it("re-reads the overlap without handing back what the baseline saw, and dedupes by external id", async () => {
    const { kb, doc } = await setup();
    const old = await kb.comment(doc.id, { body: "old", anchorText: "Keep" });
    const first = await kb.events([doc.id]);
    // The first call without a cursor lists the recent history; the office only keeps the cursor.
    expect(first.events.map((e) => e.data.commentId)).toEqual([old.id]);
    expect((await kb.events([doc.id], first.cursor)).events).toEqual([]);

    const fresh = await kb.comment(doc.id, { body: "new", anchorText: "session" });
    const next = await kb.events([doc.id], first.cursor);
    expect(next.events.map((e) => e.data.commentId)).toEqual([fresh.id]);
    const again = await kb.events([doc.id], next.cursor);
    // The overlap returns it once more with the same external id.
    expect(again.events.map((e) => e.externalId)).toEqual(next.events.map((e) => e.externalId));
  });

  it("orders by time, never by id", async () => {
    const { fake, kb, doc } = await setup();
    const base = await kb.events([doc.id]);
    const a = await kb.comment(doc.id, { body: "first", anchorText: "Keep" });
    const b = await kb.comment(doc.id, { body: "second", anchorText: "session" });
    // The ids say b then a, the times say a then b.
    const rows = fake.state.docComments;
    rows.find((x) => `${doc.id}:${x.id}` === a.id)!.id = "z-late-id";
    rows.find((x) => `${doc.id}:${x.id}` === b.id)!.id = "a-early-id";
    const page = await kb.events([doc.id], base.cursor);
    expect(page.events.map((e) => e.data.body)).toEqual(["first", "second"]);
  });

  it("skips a document that is gone, baselines an unusable cursor, and rejects garbage", async () => {
    const { kb, doc } = await setup();
    await kb.comment(doc.id, { body: "x", anchorText: "Keep" });
    expect((await kb.events(["999", doc.id])).events).toHaveLength(1);
    const old = await kb.events([doc.id], JSON.stringify({ id: 5 }));
    expect(old.events).toEqual([]);
    await expect(kb.events([doc.id], "not json")).rejects.toMatchObject({ code: "invalid" });
  });
});
