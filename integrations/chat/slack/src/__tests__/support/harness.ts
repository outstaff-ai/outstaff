import {
  silentLogger,
  type AdapterContext,
  type SecretSource,
  type TeamConfig,
} from "@outstaff/core";
import { createSlackChat } from "#/chat.js";
import type { SlackOptions } from "#/types.js";
import { BOT_TOKEN, createFakeSlack } from "./slack-fake.js";
import type { FakeSlack } from "./types.js";

export const secretMap = (values: Record<string, string>): SecretSource => ({
  get: (k) => values[k],
  require(k) {
    const v = values[k];
    if (v === undefined) {
      throw new Error(`missing ${k}`);
    }

    return v;
  },
});

/** A team whose `humans` list is given by Slack handles or ids; omit it for the default trust rule. */
export const teamWith = (chatIdentities?: string[]) =>
  ({
    people: [],
    ...(chatIdentities
      ? { humans: chatIdentities.map((chat) => ({ name: chat, identities: { chat } })) }
      : {}),
  }) as unknown as TeamConfig;

export function slackWith(
  team: TeamConfig = teamWith(),
  onWarn?: (message: string) => void,
  now: () => Date = () => new Date("2026-01-01T00:00:00Z"),
) {
  const fake: FakeSlack = createFakeSlack();
  const ctx: AdapterContext<SlackOptions> = {
    options: {},
    secrets: secretMap({ SLACK_BOT_TOKEN: BOT_TOKEN }),
    team,
    log: onWarn ? { ...silentLogger, warn: onWarn } : silentLogger,
    fetch: fake.fetch,
    now,
  };

  const chat = createSlackChat(ctx, { web: fake.web, socket: fake.socket });
  return { fake, chat };
}
