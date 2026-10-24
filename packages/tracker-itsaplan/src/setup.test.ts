import { envSecretSource, type DeriveContext, type TeamConfig } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { deriveItsaplan, itsaplanSetupGuide } from "./setup.js";

const team = (email?: string) =>
  ({
    team: { name: "acme" },
    ...(email ? { email: { pattern: email } } : {}),
  }) as unknown as TeamConfig;

const sam = { handle: "sam", name: "Sam" } as never;

describe("itsaplanSetupGuide", () => {
  it("walks through the invite-only flow with the configured address", () => {
    const steps = itsaplanSetupGuide({
      team: team("{handle}@agents.acme.example"),
      scope: "person",
      options: {},
      person: sam,
    });

    expect(steps.map((s) => s.title)).toEqual([
      "Give Sam a member account",
      "A human accepts the invite",
      "Create the API key",
    ]);

    expect(steps[0]!.body).toContain("`sam@agents.acme.example`");
    expect(steps[1]!.body).toContain("`sam`");
    expect(steps[2]!.body).toContain("ITSAPLAN_API_KEY");
  });

  it("suggests plus-addressing or a forwarding domain without an email pattern", () => {
    const [first] = itsaplanSetupGuide({ team: team(), scope: "person", options: {}, person: sam });
    expect(first!.body).toContain("+sam@");
    expect(first!.body).toContain("sam@agents.");
    expect(first!.body).toContain("Cloudflare Email Routing");
  });

  it("covers the office's own member", () => {
    const steps = itsaplanSetupGuide({ team: team(), scope: "office", options: {} });
    expect(steps[0]!.title).toBe("Give the office a member account");
  });
});

describe("deriveItsaplan", () => {
  const ctx = (reply: unknown): DeriveContext => ({
    team: team(),
    scope: "person",
    options: { url: "https://tracker.acme.example", project: "SHOP" },
    fetch: (async (url: URL, init: RequestInit) => {
      expect(String(url)).toBe("https://api.tracker.acme.example/me");
      expect((init.headers as Record<string, string>)["x-api-key"]).toBe("key");
      return new Response(JSON.stringify(reply));
    }) as unknown as typeof fetch,
    now: () => new Date(),
    warn: () => {},
  });

  it("reads the member id from /me", async () => {
    const secrets = envSecretSource({ ITSAPLAN_API_KEY: "key" }, "/nonexistent");
    expect(await deriveItsaplan(secrets, ctx({ id: 17 }))).toEqual({ ITSAPLAN_MEMBER_ID: "17" });
  });

  it("does nothing without a key", async () => {
    expect(await deriveItsaplan(envSecretSource({}, "/nonexistent"), ctx({ id: 1 }))).toEqual({});
  });
});
