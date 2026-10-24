import { describe, expect, it } from "vitest";
import { ItsaplanHttp } from "./http.js";
import { Pacer, type Clock } from "./pacing.js";

/** Virtual time: sleeping moves the clock, nothing really waits. */
function virtualClock(): Clock & { at: () => number } {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms) => {
      // Concurrent sleepers wake at their own deadline instead of adding up.
      const wake = t + ms;
      await Promise.resolve();
      t = Math.max(t, wake);
    },
    at: () => t,
  };
}

/** Reproduces the service: the 101st request of a run answers 500 until the key has been idle for a second. */
function burstLimitedService(clock: Clock) {
  let last = Number.NEGATIVE_INFINITY;
  let run = 0;
  const seen: { method: string; status: number }[] = [];
  const fetchImpl = (async (_url: URL, init?: RequestInit) => {
    const now = clock.now();
    run = now - last >= 1_000 ? 1 : run + 1;
    last = now;
    const status = run > 100 ? 500 : 200;
    seen.push({ method: init?.method ?? "GET", status });
    return new Response(status === 200 ? JSON.stringify({ ok: true }) : "Internal Server Error", {
      status,
    });
  }) as unknown as typeof fetch;

  return { fetch: fetchImpl, seen };
}

function client(clock: Clock & { at: () => number }, warnings: string[] = []) {
  const service = burstLimitedService(clock);
  const http = new ItsaplanHttp({
    fetch: service.fetch,
    apiUrl: "https://api.tracker.acme.example",
    webUrl: "https://tracker.acme.example",
    apiKey: "key-1",
    pacer: new Pacer(clock),
    clock,
    log: { debug() {}, info() {}, error() {}, warn: (m) => void warnings.push(m) },
  });

  return { http, service };
}

describe("pacing", () => {
  it("keeps a 300-request loop free of errors", async () => {
    const clock = virtualClock();
    const { http, service } = client(clock);
    for (let i = 0; i < 300; i += 1) {
      await http.request("GET", `/issues/${i}`);
    }

    expect(service.seen).toHaveLength(300);
    expect(service.seen.every((s) => s.status === 200)).toBe(true);
  });

  it("holds concurrent requests to the same budget", async () => {
    const clock = virtualClock();
    const { http, service } = client(clock);
    await Promise.all(Array.from({ length: 300 }, (_, i) => http.request("GET", `/issues/${i}`)));

    expect(service.seen.every((s) => s.status === 200)).toBe(true);
  });

  it("waits only when the budget is spent", async () => {
    const clock = virtualClock();
    const { http } = client(clock);
    const start = clock.at();
    for (let i = 0; i < 80; i += 1) {
      await http.request("GET", "/x");
    }

    expect(clock.at()).toBe(start);
    await http.request("GET", "/x");
    expect(clock.at() - start).toBeGreaterThanOrEqual(1_000);
  });
});

describe("burst limit", () => {
  // A pacer with a budget above the limit lets the 500 happen, as if another process shared the key.
  function unpaced(clock: Clock & { at: () => number }, warnings: string[]) {
    const service = burstLimitedService(clock);
    const http = new ItsaplanHttp({
      fetch: service.fetch,
      apiUrl: "https://api.tracker.acme.example",
      webUrl: "https://tracker.acme.example",
      apiKey: "key-2",
      pacer: new Pacer(clock, 1_000),
      clock,
      log: { debug() {}, info() {}, error() {}, warn: (m) => void warnings.push(m) },
    });

    return { http, service };
  }

  it("retries a GET once after the burst and logs it as rate limiting", async () => {
    const clock = virtualClock();
    const warnings: string[] = [];
    const { http, service } = unpaced(clock, warnings);
    for (let i = 0; i < 100; i += 1) {
      await http.request("GET", "/x");
    }

    await expect(http.request("GET", "/x")).resolves.toEqual({ ok: true });
    expect(service.seen.slice(-2).map((s) => s.status)).toEqual([500, 200]);
    expect(warnings).toEqual(["rate limited"]);
  });

  it("does not retry a POST", async () => {
    const clock = virtualClock();
    const { http, service } = unpaced(clock, []);
    for (let i = 0; i < 100; i += 1) {
      await http.request("GET", "/x");
    }

    await expect(http.request("POST", "/x", { body: {} })).rejects.toMatchObject({
      code: "unavailable",
    });

    expect(service.seen.filter((s) => s.method === "POST")).toHaveLength(1);
  });

  it("does not retry a 500 outside a burst", async () => {
    const clock = virtualClock();
    let calls = 0;
    const http = new ItsaplanHttp({
      fetch: (async () => {
        calls += 1;
        return new Response("boom", { status: 500 });
      }) as unknown as typeof fetch,
      apiUrl: "https://api.tracker.acme.example",
      webUrl: "https://tracker.acme.example",
      apiKey: "key-3",
      pacer: new Pacer(clock),
      clock,
    });

    await expect(http.request("GET", "/x")).rejects.toMatchObject({ code: "unavailable" });
    expect(calls).toBe(1);
  });
});
