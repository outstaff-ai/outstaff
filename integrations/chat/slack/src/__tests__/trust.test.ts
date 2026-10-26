import { silentLogger, type TeamConfig } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import type { SlackUser, SlackWeb } from "../api.js";
import { createTrust } from "../trust.js";

const web = (users: Record<string, SlackUser | undefined>, calls: string[] = []): SlackWeb =>
  ({
    users: {
      async info({ user }: { user: string }) {
        calls.push(user);
        return { user: users[user] };
      },
    },
  }) as unknown as SlackWeb;

const trustFor = (
  users: Record<string, SlackUser | undefined>,
  humans?: TeamConfig["humans"],
  calls: string[] = [],
  now: () => Date = () => new Date("2026-01-01T00:00:00Z"),
) =>
  createTrust({
    web: web(users, calls),
    humans,
    botUserId: () => "U-bot",
    now,
    log: silentLogger,
  });

describe("createTrust", () => {
  it("does not trust a user Slack returns nothing for, and asks again next time", async () => {
    const calls: string[] = [];
    const trust = trustFor({ "U-ghost": undefined }, undefined, calls);
    expect(await trust.resolve("U-ghost")).toEqual({ bot: false, trusted: false });
    await trust.resolve("U-ghost");
    expect(calls).toEqual(["U-ghost", "U-ghost"]);
  });

  it("names a sender by display name, then real name, then handle", async () => {
    const trust = trustFor({
      U1: { name: "h1", real_name: "R One", profile: { display_name: "D One" } },
      U2: { name: "h2", real_name: "R Two" },
      U3: { name: "h3" },
      U4: {},
    });

    expect((await trust.resolve("U1")).name).toBe("D One");
    expect((await trust.resolve("U2")).name).toBe("R Two");
    expect((await trust.resolve("U3")).name).toBe("h3");
    expect((await trust.resolve("U4")).name).toBeUndefined();
  });

  it("recognises the agent's own bot user even when Slack does not flag it as a bot", async () => {
    const trust = trustFor({ "U-bot": { name: "acme-bot" } });
    expect(await trust.resolve("U-bot")).toMatchObject({ bot: true, trusted: false });
  });

  it("ignores people in the humans list who have no chat identity", async () => {
    const humans = [
      { name: "kit", identities: {} },
      { name: "noor", identities: { chat: "U0NOOR001" } },
    ] as unknown as TeamConfig["humans"];

    const trust = trustFor({ U0NOOR001: { name: "noor" }, U0KIT0001: { name: "kit" } }, humans);
    expect((await trust.resolve("U0NOOR001")).trusted).toBe(true);
    expect((await trust.resolve("U0KIT0001")).trusted).toBe(false);
  });

  it("looks a user up again once the cached answer is ten minutes old", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const calls: string[] = [];
    const trust = trustFor({ U1: { name: "one" } }, undefined, calls, () => now);
    await trust.resolve("U1");
    now = new Date("2026-01-01T00:09:59Z");
    await trust.resolve("U1");
    expect(calls).toHaveLength(1);
    now = new Date("2026-01-01T00:10:00Z");
    await trust.resolve("U1");
    expect(calls).toHaveLength(2);
  });
});
