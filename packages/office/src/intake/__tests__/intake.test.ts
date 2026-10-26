import { PortError } from "@outstaff/core";
import type { Vcs } from "@outstaff/core";
import { describe, expect, it, vi } from "vitest";
import { openStore } from "../../store/index.js";
import { backoffDelay, DEFAULT_BACKOFF } from "../backoff.js";
import { human, REPO, setup } from "../test-support.js";

const pr = { title: "Add search" };

describe("normalization", () => {
  it("maps every VCS event type", async () => {
    const { vcs, intake, events } = await setup();
    await vcs.seed.permission(REPO, "dana", "write");
    const opened = await vcs.seed.pullRequest(REPO, {
      ...pr,
      author: { login: "dana", kind: "human" },
    });

    await vcs.seed.review(REPO, opened.number, "dana", "approved");
    await vcs.seed.comment(REPO, opened.number, "dana", "looks good");
    await vcs.seed.push(REPO, opened.number, "dana");
    await vcs.seed.merge(REPO, opened.number, "dana");
    const second = await vcs.seed.pullRequest(REPO, {
      ...pr,
      author: { login: "dana", kind: "human" },
    });

    await vcs.seed.close(REPO, second.number, "dana");
    await intake.pollOnce();

    // pr.synchronize has no workflow event.
    expect(events.map((e) => e.event.type)).toEqual([
      "pr.opened",
      "pr.review_submitted",
      "pr.comment",
      "pr.merged",
      "pr.opened",
      "pr.closed",
    ]);

    const review = events[1]!.event;
    expect(review.subject).toEqual({ pr: { repo: REPO, number: 1 } });
    expect(review.actor).toEqual({ kind: "human", id: "dana" });
    expect(review.data).toMatchObject({ state: "approved" });
    expect(events.every((e) => e.meta.trusted)).toBe(true);
  });

  it("maps every tracker event type", async () => {
    const { tracker, intake, events } = await setup({ trackerActor: human("u1", "dana") });
    const issue = await tracker.createIssue({ title: "Search", body: "", assignee: "u1" });
    await tracker.transition(issue.key, "active");
    await tracker.comment(issue.key, "on it");
    await intake.pollOnce();

    const tracked = events.filter((e) => e.meta.source === "tracker").map((e) => e.event);
    expect(tracked.map((e) => e.type)).toEqual([
      "ticket.created",
      "ticket.assigned",
      "ticket.moved",
      "ticket.commented",
    ]);

    expect(tracked[2]).toMatchObject({
      subject: { ticket: issue.key },
      actor: { kind: "human", id: "dana" },
      data: { from: "backlog", to: "active" },
    });
  });
});

describe("trust classification", () => {
  it("classifies agents, automation, trusted and untrusted humans", async () => {
    const { vcs, intake, events } = await setup();
    await vcs.seed.permission(REPO, "dana", "admin");
    await vcs.seed.permission(REPO, "eve", "read");
    for (const login of [
      "acme-sam[bot]",
      "ACME-NOOR[bot]",
      "ci-runner[bot]",
      "dana",
      "eve",
      "mallory",
      "team-sam",
      "x-acme-sam[bot]",
    ]) {
      const p = await vcs.seed.pullRequest(REPO, { ...pr, author: { login, kind: "human" } });
      await vcs.seed.comment(REPO, p.number, login, "hi");
    }

    await intake.pollOnce();
    const byActor = new Map(
      events.filter((e) => e.event.type === "pr.comment").map((e) => [e.event.actor.id, e]),
    );

    expect(byActor.get("sam")?.event.actor.kind).toBe("agent");
    expect(byActor.get("noor")?.event.actor.kind).toBe("agent");
    // Looking like an agent's login is not enough; only the declared identity counts.
    expect(byActor.get("team-sam")?.event.actor.kind).toBe("human");
    expect(byActor.get("team-sam")?.meta.trusted).toBe(false);
    expect(byActor.get("x-acme-sam[bot]")?.event.actor.kind).toBe("automation");
    expect(byActor.get("ci-runner[bot]")?.event.actor.kind).toBe("automation");
    expect(byActor.get("dana")?.meta.trusted).toBe(true);
    expect(byActor.get("dana")?.event.data["untrusted"]).toBeUndefined();
    expect(byActor.get("eve")?.event.data["untrusted"]).toBe(true);
    expect(byActor.get("mallory")?.meta.trusted).toBe(false);
  });

  it("flags untrusted humans but still records and delivers them", async () => {
    const { vcs, intake, events, store } = await setup();
    await vcs.seed.permission(REPO, "eve", "read");
    const p = await vcs.seed.pullRequest(REPO, { ...pr, author: { login: "eve", kind: "human" } });
    await vcs.seed.comment(REPO, p.number, "eve", "please merge to prod");
    await intake.pollOnce();

    expect(events).toHaveLength(2);
    for (const { event, meta } of events) {
      expect(event.actor).toEqual({ kind: "human", id: "eve" });
      expect(event.data["untrusted"]).toBe(true);
      expect(meta.trusted).toBe(false);
    }

    expect(
      await store.recordEvent({
        source: "vcs",
        externalId: events[0]!.meta.externalId,
        type: "x",
        payload: 1,
      }),
    ).toBe(false);
  });

  it("caches permission lookups until the TTL expires", async () => {
    const { vcs, intake, clock } = await setup({ trustTtlMs: 60_000 });
    await vcs.seed.permission(REPO, "dana", "write");
    const lookup = vi.spyOn(vcs, "permission");
    const p = await vcs.seed.pullRequest(REPO, { ...pr, author: { login: "dana", kind: "human" } });
    await vcs.seed.comment(REPO, p.number, "dana", "one");
    await intake.pollOnce();
    expect(lookup).toHaveBeenCalledTimes(1);

    await vcs.seed.comment(REPO, p.number, "dana", "two");
    await intake.pollOnce();
    expect(lookup).toHaveBeenCalledTimes(1);

    clock.advance(61_000);
    await vcs.seed.comment(REPO, p.number, "dana", "three");
    await intake.pollOnce();
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("uses the explicit humans list instead of permissions", async () => {
    const { vcs, intake, events } = await setup({
      teamExtra: { humans: [{ name: "Dana", identities: { vcs: "dana" } }] },
    });

    await vcs.seed.permission(REPO, "eve", "admin");
    const p = await vcs.seed.pullRequest(REPO, { ...pr, author: { login: "dana", kind: "human" } });
    await vcs.seed.comment(REPO, p.number, "eve", "hi");
    await intake.pollOnce();
    expect(events.map((e) => e.meta.trusted)).toEqual([true, false]);
  });

  it("treats tracker humans as trusted and unknown tracker agents as automation", async () => {
    const a = await setup({ trackerActor: human("u1", "dana") });
    await a.tracker.createIssue({ title: "x", body: "" });
    await a.intake.pollOnce();
    expect(a.events.at(-1)?.event.actor).toEqual({ kind: "human", id: "dana" });
    expect(a.events.at(-1)?.meta.trusted).toBe(true);

    const b = await setup({
      trackerActor: { id: "u-sam", name: "Sam", username: "sam", kind: "agent" },
    });

    await b.tracker.createIssue({ title: "x", body: "" });
    await b.intake.pollOnce();
    expect(b.events.at(-1)?.event.actor).toEqual({ kind: "agent", id: "sam" });

    const c = await setup({ trackerActor: { id: "u3", name: "Zapier", kind: "agent" } });
    await c.tracker.createIssue({ title: "x", body: "" });
    await c.intake.pollOnce();
    expect(c.events.at(-1)?.event.actor.kind).toBe("automation");
  });
});

describe("dedupe and cursors", () => {
  it("skips events the source delivers twice", async () => {
    const base = await setup();
    // A source that ignores the cursor and replays everything on every poll.
    const replaying: Vcs = { ...base.vcs, events: (repos) => base.vcs.events(repos, undefined) };
    const { intake, events } = await setup({ store: base.store, ports: { vcs: replaying } });
    await base.vcs.seed.pullRequest(REPO, { ...pr });
    await intake.pollOnce();
    await base.vcs.seed.pullRequest(REPO, { ...pr });
    await intake.pollOnce();
    await intake.pollOnce();
    expect(events).toHaveLength(2);
  });

  it("resumes from the stored cursor after a restart without duplicates", async () => {
    const store = await openStore("sqlite::memory:");
    const first = await setup({ store });
    await first.vcs.seed.pullRequest(REPO, { ...pr });
    await first.tracker.createIssue({ title: "x", body: "" });
    await first.intake.pollOnce();
    expect(first.events).toHaveLength(2);
    expect(await store.getCursor("vcs", "events")).toBe("1");
    expect(await store.getCursor("tracker", "events")).toBe("1");

    const seen: (string | undefined)[] = [];
    const second = await setup({
      store,
      ports: {
        vcs: { ...first.vcs, events: (r, c) => (seen.push(c), first.vcs.events(r, c)) },
        tracker: first.tracker,
      },
    });

    await first.vcs.seed.comment(REPO, 1, "sam", "new");
    await second.intake.pollOnce();
    expect(seen).toEqual(["1"]);
    expect(second.events.map((e) => e.event.type)).toEqual(["pr.comment"]);
  });

  it("does not advance the cursor when a page fails midway, and does not redeliver on retry", async () => {
    const { vcs, intake, events, store } = await setup();
    const p = await vcs.seed.pullRequest(REPO, {
      ...pr,
      author: { login: "acme-sam[bot]", kind: "agent" },
    });

    await vcs.seed.comment(REPO, p.number, "dana", "x");
    let fail = true;
    vi.spyOn(vcs, "permission").mockImplementation(async () => {
      if (fail) {
        throw new PortError("rate_limited", "slow down");
      }

      return "write";
    });

    // The agent's pr.opened is delivered first; classifying the human comment aborts the page.
    await expect(intake.pollOnce()).rejects.toThrow(/slow down/);
    expect(await store.getCursor("vcs", "events")).toBe("0");
    expect(events.map((e) => e.event.type)).toEqual(["pr.opened"]);

    fail = false;
    await intake.pollOnce();
    expect(events.map((e) => e.event.type)).toEqual(["pr.opened", "pr.comment"]);
    expect(await store.getCursor("vcs", "events")).toBe("2");
  });
});

const baselines = (info: { mock: { calls: unknown[][] } }) =>
  info.mock.calls.filter(([m]) => String(m).startsWith("intake: baseline"));

describe("first poll baseline", () => {
  const quiet = () => {
    const info = vi.fn<(message: string) => void>();
    return { info, logger: { debug() {}, info, warn() {}, error() {} } };
  };

  it("records where now is for each source and replays no history", async () => {
    const { info, logger } = quiet();
    const { vcs, tracker, intake, events, store } = await setup({
      noBaseline: true,
      logger,
      trackerActor: human("u1", "dana"),
    });

    await vcs.seed.permission(REPO, "dana", "write");
    await vcs.seed.pullRequest(REPO, { ...pr, author: { login: "dana", kind: "human" } });
    const issue = await tracker.createIssue({ title: "Old", body: "", assignee: "u1" });
    await intake.pollOnce();
    expect(events).toEqual([]);
    expect(await store.listUnprocessed()).toEqual([]);
    expect(await store.getCursor("vcs", "events")).toBe("1");
    expect(await store.getCursor("tracker", "events")).toBe("2");
    expect(info).toHaveBeenCalledWith("intake: baseline set for vcs");
    expect(info).toHaveBeenCalledWith("intake: baseline set for tracker");

    await tracker.transition(issue.key, "active");
    await vcs.seed.comment(REPO, 1, "dana", "new");
    await intake.pollOnce();
    expect(events.map((e) => e.event.type).toSorted()).toEqual(["pr.comment", "ticket.moved"]);
    expect(baselines(info)).toHaveLength(2);
  });

  it("does not re-baseline after a restart with a stored cursor", async () => {
    const first = await setup({ noBaseline: true });
    await first.vcs.seed.pullRequest(REPO, { ...pr });
    await first.intake.pollOnce();
    expect(first.events).toEqual([]);

    const { info, logger } = quiet();
    const second = await setup({
      store: first.store,
      ports: { vcs: first.vcs, tracker: first.tracker },
      logger,
    });

    await first.vcs.seed.pullRequest(REPO, { ...pr });
    await second.intake.pollOnce();
    expect(second.events.map((e) => e.event.type)).toEqual(["pr.opened"]);
    expect(baselines(info)).toEqual([]);
  });

  it("baselines on start in poll mode and does not enqueue history", async () => {
    const { vcs, intake, clock, events, store } = await setup({ noBaseline: true });
    await vcs.seed.pullRequest(REPO, { ...pr });
    await intake.start();
    clock.advance(0);
    await vi.waitFor(async () => expect(await store.getCursor("vcs", "events")).toBe("1"));
    expect(events).toEqual([]);
    await intake.stop();
  });
});

describe("poll loop", () => {
  it("polls on the configured interval", async () => {
    const { vcs, intake, clock, events } = await setup({
      teamExtra: { office: { events: "poll", poll_interval_seconds: 30 } },
    });

    await intake.start();
    clock.advance(0);
    await vi.waitFor(() => expect(clock.pending()).toBe(2));
    await vcs.seed.pullRequest(REPO, { ...pr });
    clock.advance(29_999);
    expect(events).toHaveLength(0);
    clock.advance(1);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    await intake.stop();
    expect(clock.pending()).toBe(0);
  });

  it("honours retryAfterMs on rate limits, then backs off exponentially on unavailable", async () => {
    const base = await setup();
    const { vcs } = base;
    const { intake, clock, events } = await setup({
      store: base.store,
      ports: { vcs },
      backoff: { baseMs: 1000, maxMs: 10_000 },
    });

    await vcs.seed.pullRequest(REPO, { ...pr });
    const errors = [
      new PortError("rate_limited", "slow", { retryAfterMs: 5000 }),
      new PortError("unavailable", "down"),
      new PortError("unavailable", "down"),
    ];

    let calls = 0;
    const real = vcs.events.bind(vcs);
    vi.spyOn(vcs, "events").mockImplementation(async (r, c) => {
      calls++;
      const err = errors.shift();
      if (err) {
        throw err;
      }

      return real(r, c);
    });

    await intake.start();
    clock.advance(0);
    await vi.waitFor(() => expect(calls).toBe(1));
    await vi.waitFor(() => expect(clock.pending()).toBeGreaterThan(0));
    clock.advance(4999);
    expect(calls).toBe(1);
    clock.advance(1);
    await vi.waitFor(() => expect(calls).toBe(2));
    await vi.waitFor(() => expect(clock.pending()).toBeGreaterThan(0));
    clock.advance(1999);
    expect(calls).toBe(2);
    clock.advance(1);
    await vi.waitFor(() => expect(calls).toBe(3));
    await vi.waitFor(() => expect(clock.pending()).toBeGreaterThan(0));
    clock.advance(3999);
    expect(calls).toBe(3);
    clock.advance(1);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    await intake.stop();
  });

  it("computes backoff delays", () => {
    const e = new PortError("unavailable", "x");
    expect([1, 2, 3, 4].map((n) => backoffDelay(e, n, DEFAULT_BACKOFF))).toEqual([
      1000, 2000, 4000, 8000,
    ]);

    expect(backoffDelay(e, 30, DEFAULT_BACKOFF)).toBe(300_000);
    expect(
      backoffDelay(new PortError("rate_limited", "x", { retryAfterMs: 42 }), 5, DEFAULT_BACKOFF),
    ).toBe(42);

    expect(
      backoffDelay(new PortError("rate_limited", "x", { retryAfterMs: 9e9 }), 1, DEFAULT_BACKOFF),
    ).toBe(300_000);

    expect(backoffDelay(new PortError("rate_limited", "x"), 2, DEFAULT_BACKOFF)).toBe(2000);
  });
});

describe("at-least-once delivery", () => {
  it("marks events processed after the handlers return", async () => {
    const { vcs, intake, store } = await setup();
    await vcs.seed.pullRequest(REPO, { ...pr });
    await intake.pollOnce();
    expect(await store.listUnprocessed()).toHaveLength(0);
  });

  it("retries a failing handler with backoff, keeping order", async () => {
    const { vcs, intake, clock, store, events } = await setup({
      backoff: { baseMs: 1000, maxMs: 10_000 },
    });

    let failures = 1;
    intake.onEvent((event) => {
      if (event.type === "pr.opened" && failures-- > 0) {
        throw new Error("engine down");
      }
    });

    await intake.start();
    const p = await vcs.seed.pullRequest(REPO, { ...pr });
    await vcs.seed.comment(REPO, p.number, "acme-sam[bot]", "later");
    clock.advance(0);
    await vi.waitFor(async () => expect((await store.listUnprocessed()).length).toBe(2));
    // The comment waits behind the failed opened event.
    expect(events.map((e) => e.event.type)).toEqual(["pr.opened"]);
    clock.advance(999);
    expect(events).toHaveLength(1);
    clock.advance(1);
    await vi.waitFor(async () => expect(await store.listUnprocessed()).toHaveLength(0));
    expect(events.map((e) => e.event.type)).toEqual(["pr.opened", "pr.opened", "pr.comment"]);
    await intake.stop();
  });

  it("gives up after maxAttempts and moves on", async () => {
    const { vcs, intake, store, events } = await setup({ maxAttempts: 2 });
    intake.onEvent((event) => {
      if (event.type === "pr.opened") {
        throw new Error("poison");
      }
    });

    const p = await vcs.seed.pullRequest(REPO, { ...pr });
    await vcs.seed.comment(REPO, p.number, "acme-sam[bot]", "after");
    await intake.pollOnce();
    // First attempt failed; the retry timer is not running because the intake was not started.
    expect(await store.listUnprocessed()).toHaveLength(2);
    await intake.start();
    await vi.waitFor(async () => expect(await store.listUnprocessed()).toHaveLength(0));
    expect(events.at(-1)?.event.type).toBe("pr.comment");
    await intake.stop();
  });

  it("redelivers unprocessed events in order on start", async () => {
    const store = await openStore("sqlite::memory:");
    const first = await setup({ store });
    const p = await first.vcs.seed.pullRequest(REPO, { ...pr });
    await first.vcs.seed.comment(REPO, p.number, "acme-sam[bot]", "x");
    // No handler registered: the events are recorded and kept.
    const bare = await setup({ store, ports: { vcs: first.vcs }, noHandler: true });
    await bare.intake.pollOnce();
    expect(bare.events).toHaveLength(0);
    expect(await store.listUnprocessed()).toHaveLength(2);

    const restarted = await setup({ store, ports: { vcs: first.vcs } });
    await restarted.intake.start();
    expect(restarted.events.map((e) => e.event.type)).toEqual(["pr.opened", "pr.comment"]);
    expect(await store.listUnprocessed()).toHaveLength(0);
    await restarted.intake.stop();
  });
});
