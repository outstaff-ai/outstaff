import { parseTeamConfig, type TeamConfig } from "@outstaff/core";
import { createFakeChat } from "@outstaff/core/fakes";
import type { WorkSummary } from "@outstaff/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROFILE_HINT, createProfilePublisher } from "#/runner/profile.js";
import type { ProfilePublisher } from "#/runner/types.js";

function team(humans: boolean): TeamConfig {
  const result = parseTeamConfig({
    version: 1,
    team: { name: "acme" },
    ...(humans
      ? {
          humans: [
            { name: "Dana", identities: { chat: "U0DANA0001" } },
            { name: "Vic", identities: { vcs: "vic" } },
            { name: "Lee", identities: { chat: "U0LEE00002" } },
          ],
        }
      : {}),
    catalog: { version: "1.0.0" },
    repos: [{ name: "app", url: "git.acme.example/acme/app", kind: "primary" }],
    people: [{ handle: "sam", name: "Sam", role: "developer" }],
    integrations: {
      chat: { adapter: "fake" },
      vcs: { adapter: "fake" },
      runtime: { adapter: "fake" },
      tracker: { adapter: "fake" },
    },
  });

  if (!result.ok) {
    throw new Error(JSON.stringify(result.issues));
  }

  return result.config;
}

const item = (id: string, extra: Partial<WorkSummary> = {}): WorkSummary => ({
  id,
  title: `Work ${id}`,
  status: "queued",
  ...extra,
});

describe("profile publisher", () => {
  let chat: ReturnType<typeof createFakeChat>;
  let items: WorkSummary[];
  let clock: number;
  let publisher: ProfilePublisher;

  const make = (humans = true) =>
    createProfilePublisher({
      chat,
      office: { work: async () => structuredClone(items) },
      team: team(humans),
      who: { name: "Sam", role: "Developer", description: "Builds features.", model: "sonnet" },
      tracker: { links: { issue: (key: string) => `https://t.acme.example/${key}` } as never },
      now: () => clock,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    chat = createFakeChat();
    items = [];
    clock = Date.parse("2030-01-01T10:00:00Z");
  });

  afterEach(() => {
    publisher?.stop();
    vi.useRealTimers();
  });

  it("publishes an idle profile at start to each human with a chat identity", async () => {
    publisher = make();
    await publisher.start();

    expect(chat.profileLog.map((p) => p.userId)).toEqual(["U0DANA0001", "U0LEE00002"]);
    expect(chat.profileLog[0]!.profile).toEqual({
      name: "Sam",
      role: "Developer",
      description: "Builds features.",
      model: "sonnet",
      status: "idle",
      lastActiveAt: "2030-01-01T10:00:00.000Z",
      hint: PROFILE_HINT,
      sections: [{ heading: "Current work", lines: [] }],
    });
  });

  it("states how to talk to the agent: questions answered right away, work filed or joined", () => {
    expect(PROFILE_HINT).toContain("Ask a question and I answer right away");
    expect(PROFILE_HINT).toContain("turn it into a ticket, or add it to work I already have");
  });

  it("shows the active item linked and the work grouped by ticket in queue order", async () => {
    items = [
      item("w1", { status: "active", ticketKey: "ACME-1", ticketTitle: "Checkout" }),
      item("w2", {
        kind: "review_feedback",
        status: "queued",
        ticketKey: "ACME-1",
        pr: "p4",
        prNumber: 4,
        prUrl: "https://git.acme.example/acme/app/pull/4",
      }),
      item("w3", { ticketKey: "ACME-2", ticketTitle: "Cart" }),
      item("c1", { kind: "chat", status: "active", title: "Chat" }),
    ];

    publisher = make();
    await publisher.start();
    const p = chat.profileLog[0]!.profile;

    expect(p.status).toBe("working");
    expect(p.current).toEqual({ title: "ACME-1 Checkout", url: "https://t.acme.example/ACME-1" });
    expect(p.sections![0]!.lines).toEqual([
      "1. [ACME-1 Checkout](https://t.acme.example/ACME-1) (running; queued: addressing review on [PR #4](https://git.acme.example/acme/app/pull/4))",
      "2. [ACME-2 Cart](https://t.acme.example/ACME-2)",
    ]);
  });

  it("publishes once for a burst of changes, after they settle", async () => {
    publisher = make();
    await publisher.start();
    const before = chat.profileLog.length;

    items = [item("w1", { status: "active", ticketKey: "ACME-1", ticketTitle: "Checkout" })];
    for (let i = 0; i < 5; i++) {
      publisher.changed();
    }

    await vi.advanceTimersByTimeAsync(1000);
    expect(chat.profileLog).toHaveLength(before);

    await vi.advanceTimersByTimeAsync(1500);
    expect(chat.profileLog).toHaveLength(before + 2);
    expect(chat.profileLog.at(-1)!.profile.status).toBe("working");
  });

  it("follows an item through offer, hand-back and idle, keeping when it was last active", async () => {
    publisher = make();
    await publisher.start();

    const publishAfterChange = async () => {
      publisher.changed();
      await vi.advanceTimersByTimeAsync(2500);
      return chat.profileLog.filter((p) => p.userId === "U0DANA0001").at(-1)!.profile;
    };

    items = [item("w1", { ticketKey: "ACME-1", ticketTitle: "Checkout" })];
    expect((await publishAfterChange()).status).toBe("idle");

    items = [item("w1", { status: "active", ticketKey: "ACME-1", ticketTitle: "Checkout" })];
    clock += 60_000;
    const working = await publishAfterChange();
    expect(working.status).toBe("working");
    expect(working.lastActiveAt).toBe("2030-01-01T10:01:00.000Z");

    items = [];
    clock += 600_000;
    const idle = await publishAfterChange();
    expect(idle.status).toBe("idle");
    expect(idle.current).toBeUndefined();
    expect(idle.lastActiveAt).toBe("2030-01-01T10:01:00.000Z");
  });

  it("republishes at least every 5 minutes while working, and not while idle", async () => {
    publisher = make();
    await publisher.start();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(chat.profileLog).toHaveLength(2);

    items = [item("w1", { status: "active", ticketKey: "ACME-1" })];
    publisher.changed();
    await vi.advanceTimersByTimeAsync(2500);
    const n = chat.profileLog.length;
    clock += 300_000;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(chat.profileLog.length).toBeGreaterThan(n);
    expect(chat.profileLog.at(-1)!.profile.lastActiveAt).toBe(new Date(clock).toISOString());
  });

  it("publishes nothing without a list of humans, but builds the profile on request", async () => {
    publisher = make(false);
    await publisher.start();
    expect(chat.profileLog).toEqual([]);
    expect(await chat.openProfile("U0ANYONE1")).toMatchObject({ name: "Sam", status: "idle" });
  });

  it("keeps going when the office or the chat fails", async () => {
    const warn = vi.fn<(message: string) => void>();
    const failing = {
      setAgentProfile: vi.fn<() => Promise<void>>().mockRejectedValue(new Error("rate limited")),
    };

    publisher = createProfilePublisher({
      chat: failing,
      office: { work: async () => items },
      team: team(true),
      who: { name: "Sam", role: "Developer" },
      log: { debug() {}, info() {}, warn, error() {} } as never,
      now: () => clock,
    });

    await expect(publisher.start()).resolves.toBeUndefined();
    expect(failing.setAgentProfile).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
