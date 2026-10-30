import {
  AdapterRegistry,
  PortError,
  envSecretSource,
  parseTeamConfig,
  silentLogger,
} from "@outstaff/core";
import { createFakeAdapterRegistry } from "@outstaff/core/fakes";
import { slackChat } from "@outstaff/integration.chat.slack";
import { describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import { createOfficePorts } from "#/ports.js";

const team = (office: Record<string, unknown> = { channel: "C0TEAM" }) => {
  const result = parseTeamConfig({
    version: 1,
    team: { name: "acme" },
    catalog: { version: "1.0.0" },
    repos: [{ name: "app", url: "git.acme.example/acme/app", kind: "primary" }],
    people: [{ handle: "sam", name: "Sam", role: "developer", model: "sonnet" }],
    office,
    integrations: {
      vcs: { adapter: "fake" },
      chat: { adapter: "slack" },
      runtime: { adapter: "fake" },
    },
  });

  if (!result.ok) {
    throw new Error("fixture invalid");
  }

  return result.config;
};

const registry = () => {
  const stock = createFakeAdapterRegistry();
  return new AdapterRegistry().register(stock.get("vcs", "fake")!).register(slackChat);
};

const ports = (env: Record<string, string>, office?: Record<string, unknown>) =>
  createOfficePorts({
    team: team(office),
    registry: registry(),
    secrets: envSecretSource(env, "/nonexistent"),
    clock: manualClock(),
    logger: silentLogger,
  });

describe("office chat port", () => {
  it("is created in office scope from the office bot token alone", async () => {
    const out = await ports({ SLACK_OFFICE_BOT_TOKEN: "xoxb-office" });
    expect(out.chat).toBeDefined();
  });

  it("does not accept an agent's token in its place", async () => {
    const error = await ports({ SLACK_BOT_TOKEN: "xoxb-agent" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PortError);
    expect((error as PortError).message).toContain("SLACK_OFFICE_BOT_TOKEN");
  });

  it("fails at startup, naming the key, when the team channel is set and chat has no office credentials", async () => {
    await expect(ports({})).rejects.toThrow(
      /office has no Slack credentials.*SLACK_OFFICE_BOT_TOKEN/,
    );
  });

  it("is not created without a team channel: the office posts to nobody, so it needs no chat app", async () => {
    const out = await ports({}, {});
    expect(out.chat).toBeUndefined();
  });
});
