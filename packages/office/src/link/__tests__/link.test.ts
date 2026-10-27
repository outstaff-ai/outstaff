import { silentLogger, type Logger } from "@outstaff/core";
import { linkMessageSchema } from "@outstaff/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "../../clock.js";
import type { ManualClock } from "../../types.js";
import { openStore, type Store } from "../../store/index.js";
import { ITEM_EVENTS_SUBJECT } from "../../pipeline/live/wake.js";
import { createOfficeLink } from "../client.js";
import type { OfficeLink, OfficeLinkOptions } from "../link.types.js";
import { FakeService, until } from "./service.js";
import { record, trace } from "./support.js";

const TOKEN = "dash-token";

describe("the office link", () => {
  let clock: ManualClock;
  let store: Store;
  let dash: FakeService;
  let link: OfficeLink;
  let online: string[];
  let warned: string[];

  const start = (extra: Partial<OfficeLinkOptions> = {}, defaults = false) => {
    const base = {
      url: dash.url,
      token: TOKEN,
      team: { people: [{ handle: "sam", name: "Sam Duarte", role: "developer" }] as never },
      store,
      links: {
        ticket: (key: string) => `https://tracker.acme.example/issue/${key}`,
        pr: (pr: { number: number }) => `https://github.com/acme-example/shop/pull/${pr.number}`,
      },
      identity: { team: "acme", version: "1.2.3", pipelineMode: "shadow" as const },
      connected: () => online,
      clock,
      logger: { ...silentLogger, warn: (m: string) => void warned.push(m) } as Logger,
    };

    link = createOfficeLink(
      defaults
        ? base
        : {
            ...base,
            pollMs: 1000,
            pingMs: 15_000,
            requestTimeoutMs: 5000,
            backoff: { baseMs: 100, maxMs: 400 },
            random: () => 1,
            ...extra,
          },
    );

    link.start();
  };

  const connected = async () => {
    await until(() => dash.links.length >= 1);
    dash.welcome();
    await until(() => dash.of("people").length === 1);
  };

  beforeEach(async () => {
    clock = manualClock("2026-10-05T10:00:00.000Z");
    store = await openStore("sqlite::memory:", { now: () => clock.now() });
    dash = new FakeService(TOKEN);
    await dash.ready();
    online = ["sam"];
    warned = [];
  });

  afterEach(async () => {
    await link.stop();
    await dash.close();
    await store.close();
  });

  it("authenticates and, once welcomed, sends the people and answers requests", async () => {
    start();
    await until(() => dash.links.length === 1);
    expect(dash.last.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(dash.last.headers["outstaff-link-version"]).toBe("1");
    expect(link.status().state).toBe("connecting");

    // Before the welcome nothing is answered.
    dash.send({ type: "request", payload: { id: "early", method: "people" } });
    dash.welcome();
    await until(() => dash.of("people").length === 1);
    expect(dash.of("people")[0]!.payload.people).toEqual([
      {
        handle: "sam",
        name: "Sam Duarte",
        role: "developer",
        connected: true,
        counts: { queued: 0, running: 0 },
        current: null,
        queue: [],
      },
    ]);

    expect(dash.of("hello").map((m) => m.payload)).toEqual([
      { office: { team: "acme", version: "1.2.3", pipelineMode: "shadow" } },
    ]);

    expect(await dash.request({ method: "people" })).toMatchObject({
      result: { at: "2026-10-05T10:00:00.000Z", people: [{ handle: "sam" }] },
    });

    expect(dash.of("response").map((r) => r.payload.id)).not.toContain("early");
    expect(link.status()).toEqual({ state: "connected" });
  });

  it("answers events, event and item, and says when there is nothing", async () => {
    await record(store, trace("tracker:1", "2026-10-05T09:00:00.000Z", { ticket: "ACME-1" }));
    await record(store, trace("vcs:2", "2026-10-05T09:01:00.000Z", { pr: 9 }));
    const item = await store.enqueue({
      person: "sam",
      kind: "assigned",
      title: "assigned: ACME-1",
      trigger: "human",
    });

    start();
    await connected();

    const events = await dash.request({ method: "events", params: { ticket: "ACME-1" } });
    expect(events).toMatchObject({
      result: {
        events: [
          {
            event: { id: "tracker:1", source: "tracker" },
            urls: { ticket: "https://tracker.acme.example/issue/ACME-1" },
          },
        ],
      },
    });

    expect(
      (await dash.request({ method: "events" })) as { result: { events: unknown[] } },
    ).toMatchObject({
      result: { events: [{ event: { id: "vcs:2" } }, { event: { id: "tracker:1" } }] },
    });

    expect(await dash.request({ method: "event", params: { id: "vcs:2" } })).toMatchObject({
      result: { trace: { event: { id: "vcs:2" } } },
    });

    expect(await dash.request({ method: "event", params: { id: "vcs:404" } })).toMatchObject({
      error: { code: "not_found", message: "No trace for event vcs:404." },
    });

    expect(await dash.request({ method: "item", params: { id: item.id } })).toMatchObject({
      result: { item: { id: item.id, status: "queued" }, traces: [] },
    });

    await store.upsertSubject(ITEM_EVENTS_SUBJECT, item.id, ["vcs:2"]);
    expect(await dash.request({ method: "item", params: { id: item.id } })).toMatchObject({
      result: {
        traces: [
          {
            event: { id: "vcs:2", source: "vcs" },
            urls: { pr: "https://github.com/acme-example/shop/pull/9" },
          },
        ],
      },
    });

    expect(await dash.request({ method: "items", params: { status: "queued" } })).toMatchObject({
      result: { items: [{ id: item.id, status: "queued", scheduledBy: null }] },
    });

    expect(await dash.request({ method: "items" })).toMatchObject({
      result: { items: [{ id: item.id }] },
    });

    expect(await dash.request({ method: "item", params: { id: "nope" } })).toMatchObject({
      error: { code: "not_found", message: "No work item nope." },
    });

    for (const raw of dash.raw) {
      expect(linkMessageSchema.safeParse(JSON.parse(raw)).success).toBe(true);
    }
  });

  it("answers an unknown method, bad params, a failure and a request that takes too long with an error", async () => {
    let hang = false;
    let broken = false;
    const odd = {
      ...store,
      getTrace: (ref: string) =>
        hang
          ? new Promise<never>(() => {})
          : broken
            ? Promise.reject(new Error("disk"))
            : store.getTrace(ref),
    } as unknown as Store;

    start({ store: odd });
    await connected();
    const raw = (payload: unknown) =>
      dash.last.ws.send(JSON.stringify({ type: "request", payload }));

    raw({ id: "u1", method: "nope" });
    raw({ id: "u2" });
    raw({ id: "b1", method: "events", params: { limit: 0 } });
    await until(() => dash.of("response").length === 3);
    expect(dash.of("response").map((r) => r.payload)).toEqual([
      { id: "u1", error: { code: "unknown_method", message: "No method nope." } },
      { id: "u2", error: { code: "unknown_method", message: "No method (none)." } },
      { id: "b1", error: { code: "invalid", message: expect.stringContaining("limit") } },
    ]);

    broken = true;
    expect(await dash.request({ method: "event", params: { id: "x" } })).toEqual({
      id: expect.any(String),
      error: { code: "failed", message: "The office could not answer." },
    });

    expect(warned).toEqual(["office link: a request failed"]);
    broken = false;
    hang = true;
    dash.send({ type: "request", payload: { id: "slow", method: "event", params: { id: "x" } } });
    await new Promise((r) => setTimeout(r, 20));
    clock.advance(5000);
    await until(() => dash.of("response").some((r) => r.payload.id === "slow"));
    expect(dash.of("response").find((r) => r.payload.id === "slow")!.payload).toEqual({
      id: "slow",
      error: { code: "timeout", message: "No answer within 5000 ms." },
    });
  });

  it("notifies new traces, item changes and changed people, and nothing that existed before", async () => {
    await record(store, trace("tracker:old", "2026-10-05T08:00:00.000Z"));
    const item = await store.enqueue({
      person: "sam",
      kind: "assigned",
      title: "t",
      trigger: "human",
    });

    start();
    await connected();

    clock.advance(1);
    await record(store, trace("tracker:new", "2026-10-05T10:00:00.000Z"));
    await store.activateItem(item.id);
    const queued = await store.enqueue({
      person: "sam",
      kind: "ci_failed",
      title: "ci",
      trigger: "automation",
    });

    online = [];
    clock.advance(1000);
    await until(() => dash.of("people").length === 2 && dash.of("item").length === 2);
    expect(dash.of("trace").map((m) => m.payload.trace.event.id)).toEqual(["tracker:new"]);
    expect(dash.of("item").map((m) => [m.payload.id, m.payload.status])).toEqual([
      [item.id, "active"],
      [queued.id, "queued"],
    ]);

    expect(dash.of("people")[1]!.payload.people[0]).toMatchObject({
      connected: false,
      current: { id: item.id },
    });

    clock.advance(1000);
    await new Promise((r) => setTimeout(r, 50));
    expect([dash.of("people").length, dash.of("item").length, dash.of("trace").length]).toEqual([
      2, 2, 1,
    ]);

    // A burst larger than one read of the store is sent whole, in order.
    for (let i = 0; i < 150; i++) {
      await record(store, trace(`burst:${String(i).padStart(3, "0")}`, "2026-10-05T10:01:00.000Z"));
    }

    clock.advance(1000);
    await until(() => dash.of("trace").length === 151);
    expect(dash.of("trace").at(-1)!.payload.trace.event.id).toBe("burst:149");
  });

  it("logs a failure to read the store for a notification and keeps the link up", async () => {
    let fail = false;
    const flaky = {
      ...store,
      listItems: (f?: Parameters<Store["listItems"]>[0]) =>
        fail ? Promise.reject(new Error("store down")) : store.listItems(f),
    } as unknown as Store;

    start({ store: flaky });
    await connected();
    fail = true;
    clock.advance(1000);
    await until(() => warned.includes("office link: could not notify the service: store down"));

    fail = false;
    online = [];
    clock.advance(1000);
    await until(() => dash.of("people").length === 2);
    expect(link.status().state).toBe("connected");
  });

  it("backs off, doubling up to the cap, while the service refuses the token", async () => {
    dash.refuse = true;
    start();
    await until(() => link.status().state === "backoff");
    expect(link.status().lastError).toMatch(/401/);
    const attempts = () => warned.filter((w) => w.includes("401")).length;
    for (const [ms, expected] of [
      [99, 1],
      [1, 2],
      [200, 3],
      [400, 4],
      [400, 5],
    ] as const) {
      clock.advance(ms);
      await until(() => attempts() >= expected && link.status().state === "backoff");
      expect(attempts()).toBe(expected);
    }

    dash.refuse = false;
    clock.advance(400);
    await connected();
    expect(link.status()).toEqual({ state: "connected" });
  });

  it("closes on another link version, answers pings, pings a quiet service and drops a silent one", async () => {
    start();
    await until(() => dash.links.length === 1);
    dash.welcome(2);
    await until(() => link.status().state === "backoff");
    expect(link.status().lastError).toBe("the service speaks another link version: 2, not 1");

    clock.advance(100);
    await until(() => dash.links.length === 2);
    dash.last.ws.send("not json");
    dash.send({ type: "ping", payload: {} });
    await until(() => dash.of("pong").length === 1);
    dash.welcome();
    await until(() => dash.of("people").length === 1);
    clock.advance(15_000);
    await until(() => dash.of("ping").length >= 1);
    clock.advance(45_000);
    await until(() => link.status().state === "backoff");
    expect(link.status().lastError).toBe("the service went quiet: no message for 45 s");
  });

  it("works with its defaults, stops while connecting or backing off, and starts once", async () => {
    start({}, true);
    link.start();
    await connected();
    await link.stop();
    expect(link.status().state).toBe("stopped");

    start();
    await link.stop();
    dash.refuse = true;
    start();
    await until(() => link.status().state === "backoff");
    await link.stop();
    clock.advance(1000);
    expect(link.status().state).toBe("stopped");
  });
});
