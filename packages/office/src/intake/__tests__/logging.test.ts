import { PortError } from "@outstaff/core";
import type { Logger, Vcs } from "@outstaff/core";
import { describe, expect, it, vi } from "vitest";
import { REPO, setup } from "../test-support.js";

interface Line {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fields: Record<string, unknown>;
}

function recorder() {
  const lines: Line[] = [];
  const at =
    (level: Line["level"]) =>
    (message: string, fields: Record<string, unknown> = {}) =>
      void lines.push({ level, message, fields });

  const logger: Logger = {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  };

  return {
    lines,
    logger,
    messages: (level: Line["level"]) =>
      lines.filter((l) => l.level === level).map((l) => l.message),
  };
}

describe("intake logging", () => {
  it("logs each recorded event with source, type, subject, actor and trust", async () => {
    const { logger, messages, lines } = recorder();
    const { vcs, intake } = await setup({ logger });
    await vcs.seed.permission(REPO, "dana", "write");
    const opened = await vcs.seed.pullRequest(REPO, {
      title: "Add search",
      author: { login: "acme-sam[bot]", kind: "agent" },
    });

    await vcs.seed.review(REPO, opened.number, "dana", "commented", "a very long body ".repeat(20));
    await vcs.seed.comment(REPO, opened.number, "eve", "who am I");
    await intake.pollOnce();

    expect(messages("info")).toEqual(
      expect.arrayContaining([
        "intake: recorded vcs pr.opened on acme/app#1 by sam (trusted)",
        "intake: recorded vcs pr.review_submitted on acme/app#1 by dana (trusted)",
        "intake: recorded vcs pr.comment on acme/app#1 by eve (untrusted)",
      ]),
    );

    expect(lines.find((l) => l.message.includes("by dana"))?.fields).toEqual({
      source: "vcs",
      type: "pr.review_submitted",
      subject: "acme/app#1",
      actor: "dana",
      actorKind: "human",
      trusted: true,
    });
  });

  it("logs a tracker event by its ticket key", async () => {
    const { logger, messages } = recorder();
    const { tracker, intake } = await setup({ logger });
    const issue = await tracker.createIssue({ title: "Search", body: "" });
    await intake.pollOnce();
    expect(
      messages("info").some((m) =>
        m.startsWith(`intake: recorded tracker ticket.created on ${issue.key} by `),
      ),
    ).toBe(true);
  });

  it("logs events the office does not map at info once per event id, and duplicates at debug", async () => {
    const { logger, lines } = recorder();
    const { vcs, intake, store } = await setup({ logger });
    const pr = await vcs.seed.pullRequest(REPO, {
      title: "Add search",
      author: { login: "acme-sam[bot]", kind: "agent" },
    });

    await vcs.seed.push(REPO, pr.number, "acme-sam[bot]");
    await intake.pollOnce();
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: "info",
        message:
          "intake: dropped vcs pr.synchronize on acme/app#1: the office does not map this event type",
        fields: expect.objectContaining({ reason: "the office does not map this event type" }),
      }),
    );

    // The same event arriving again, as a webhook retry would.
    await store.setCursor("vcs", "events", "0");
    await intake.pollOnce();
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: "debug",
        message:
          "intake: dropped vcs pr.opened on acme/app#1: duplicate of an event already recorded",
      }),
    );

    // The unmapped event came back too: now at debug, not info again.
    const unmapped = lines.filter((l) => l.message.includes("pr.synchronize"));
    expect(unmapped.map((l) => l.level)).toEqual(["info", "debug"]);
    expect(lines.filter((l) => l.level === "info" && l.message.includes("duplicate"))).toEqual([]);
  });

  it("logs events the adapter read but could not map", async () => {
    const { logger, messages } = recorder();
    const base = await setup({ logger });
    const vcs: Vcs = {
      ...base.vcs,
      events: async () => ({
        events: [],
        cursor: "9",
        unmapped: [{ externalId: "77", type: "PushEvent", repo: REPO }],
      }),
    };

    const { intake } = await setup({ logger, store: base.store, ports: { vcs } });
    await intake.pollOnce();
    expect(messages("info")).toContain(
      "intake: dropped vcs PushEvent on acme/app: the adapter does not map this event type",
    );
  });

  it("logs an adapter-unmapped event at info the first time, then at debug", async () => {
    const { logger, lines } = recorder();
    const base = await setup({ logger });
    const vcs: Vcs = {
      ...base.vcs,
      events: async () => ({
        events: [],
        cursor: "9",
        unmapped: [{ externalId: "77", type: "PushEvent", repo: REPO }],
      }),
    };

    const { intake } = await setup({ logger, store: base.store, ports: { vcs } });
    await intake.pollOnce();
    await intake.pollOnce();
    expect(lines.filter((l) => l.message.includes("PushEvent")).map((l) => l.level)).toEqual([
      "info",
      "debug",
    ]);
  });

  const failingVcs = (base: Awaited<ReturnType<typeof setup>>): Vcs => ({
    ...base.vcs,
    events: async () => {
      throw new PortError("unavailable", `down ${"x".repeat(500)}`);
    },
  });

  /** Lets `count` failing polls happen, one backoff step (a minute) apart. */
  async function failPolls(
    count: number,
    lines: Line[],
    extra: { stalePollMinutes?: number } = {},
  ) {
    const base = await setup({ logger: { debug() {}, info() {}, warn() {}, error() {} } });
    const { intake, clock } = await setup({
      store: base.store,
      ports: { vcs: failingVcs(base) },
      backoff: { baseMs: 60_000, maxMs: 60_000 },
      logger: {
        debug() {},
        info() {},
        warn: (m, f) => void lines.push({ level: "warn", message: m, fields: f ?? {} }),
        error: (m, f) => void lines.push({ level: "error", message: m, fields: f ?? {} }),
      },
      ...extra,
    });

    await intake.start();
    for (let i = 0; i < count; i++) {
      clock.advance(i === 0 ? 0 : 60_000);
      await vi.waitFor(() => expect(lines.filter((l) => l.level === "error")).toHaveLength(i + 1));
      await vi.waitFor(() => expect(clock.pending()).toBeGreaterThan(0));
    }

    await intake.stop();
  }

  it("logs a failed poll as an error with the code, clipping the message", async () => {
    const lines: Line[] = [];
    await failPolls(1, lines);
    const failure = lines.find((l) => l.level === "error");
    expect(failure?.message).toBe("intake: vcs poll failed (unavailable), retrying in 60s");
    expect(failure?.fields).toMatchObject({
      source: "vcs",
      code: "unavailable",
      retryInMs: 60_000,
    });

    expect(String(failure?.fields["error"]).length).toBeLessThanOrEqual(200);
    expect(lines.filter((l) => l.level === "warn")).toEqual([]);
  });

  it("warns when a source has had no successful poll for the configured time", async () => {
    const lines: Line[] = [];
    await failPolls(5, lines, { stalePollMinutes: 3 });
    const warnings = lines.filter((l) => l.level === "warn").map((l) => l.message);
    expect(warnings).toEqual([
      "intake: no successful vcs poll for 3 minutes",
      "intake: no successful vcs poll for 4 minutes",
    ]);
  });

  it("uses 10 minutes by default", async () => {
    const lines: Line[] = [];
    await failPolls(10, lines);
    expect(lines.filter((l) => l.level === "warn")).toEqual([]);

    const more: Line[] = [];
    await failPolls(11, more);
    expect(more.filter((l) => l.level === "warn").map((l) => l.message)).toEqual([
      "intake: no successful vcs poll for 10 minutes",
    ]);
  });
});
