import { envSecretSource, type DeriveContext, type TeamConfig } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { deriveSlack, slackSetupGuide } from "#/setup.js";

const team = { team: { name: "acme" } } as unknown as TeamConfig;
const sam = { handle: "sam", name: "Sam", role: "developer", model: "sonnet" } as never;

describe("slackSetupGuide", () => {
  it("gives a Socket Mode manifest with the scopes and events the adapter uses", () => {
    const steps = slackSetupGuide({ team, scope: "person", options: {}, person: sam });
    expect(steps.map((s) => s.title)).toEqual([
      "Create Sam's Slack app",
      "Create the app-level token",
      "Install the app and copy the bot token",
    ]);

    const manifest = steps[0]!.manifest!;
    expect(manifest).toContain("socket_mode_enabled: true");
    expect(manifest).toContain("- app_mention");
    expect(manifest).toContain("- chat:write");
    expect(manifest).toContain("- files:read");
    expect(manifest).toContain('display_name: "sam"');
  });

  it("gives the office a post-only app with its own token", () => {
    const steps = slackSetupGuide({ team, scope: "office", options: {} });
    expect(steps.map((s) => s.title)).toEqual([
      "Create the office's Slack app",
      "Install the app and copy the bot token",
    ]);

    const manifest = steps[0]!.manifest!;
    expect(manifest).toContain('name: "acme-outstaff-office"');
    expect(manifest).toContain("socket_mode_enabled: false");
    expect(manifest).not.toContain("event_subscriptions");
    expect(steps[1]!.body).toContain("SLACK_OFFICE_BOT_TOKEN");
  });
});

describe("slackSetupGuide without a person", () => {
  it("has nothing to say for an agent that is not named", () => {
    expect(slackSetupGuide({ team, scope: "person", options: {} })).toEqual([]);
  });
});

describe("deriveSlack", () => {
  const warnings: string[] = [];
  const ctx = (reply: unknown): DeriveContext => ({
    team,
    scope: "person",
    options: {},
    fetch: (async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer xoxb-1");
      return new Response(JSON.stringify(reply));
    }) as unknown as typeof fetch,
    now: () => new Date(),
    warn: (m) => warnings.push(m),
  });

  const secrets = (env: Record<string, string>) => envSecretSource(env, "/nonexistent");

  it("asks auth.test for the bot user id", async () => {
    expect(
      await deriveSlack(secrets({ SLACK_BOT_TOKEN: "xoxb-1" }), ctx({ ok: true, user_id: "U123" })),
    ).toEqual({ SLACK_BOT_USER_ID: "U123" });
  });

  it("does nothing when the id is known or the token is missing, and warns on failure", async () => {
    expect(
      await deriveSlack(secrets({ SLACK_BOT_TOKEN: "xoxb-1", SLACK_BOT_USER_ID: "U1" }), ctx({})),
    ).toEqual({});

    expect(await deriveSlack(secrets({}), ctx({}))).toEqual({});
    expect(
      await deriveSlack(
        secrets({ SLACK_BOT_TOKEN: "xoxb-1" }),
        ctx({ ok: false, error: "invalid_auth" }),
      ),
    ).toEqual({});

    expect(warnings).toEqual(["Slack auth.test failed: invalid_auth"]);
  });

  it("reports the HTTP status when Slack gives no error string", async () => {
    warnings.length = 0;
    expect(await deriveSlack(secrets({ SLACK_BOT_TOKEN: "xoxb-1" }), ctx({ ok: false }))).toEqual(
      {},
    );

    expect(warnings).toEqual(["Slack auth.test failed: 200"]);
  });
});
