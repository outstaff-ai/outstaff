import { describe, expect, it } from "vitest";
import { envSecretSource, silentLogger, type TeamConfig } from "@outstaff/core";
import { slackChat } from "./index.js";

// Talks to a real Slack app. Set OUTSTAFF_TEST_SLACK_USER (a member id the app may DM) plus SLACK_BOT_TOKEN and
// SLACK_APP_TOKEN. It posts to that user's direct channel, replies in the thread, reacts and reads history.
const user = process.env["OUTSTAFF_TEST_SLACK_USER"];

describe.skipIf(!user)(
  "slack live (set OUTSTAFF_TEST_SLACK_USER, SLACK_BOT_TOKEN and SLACK_APP_TOKEN to run)",
  () => {
    it("posts, reacts, reads history and publishes a profile", { timeout: 60_000 }, async () => {
      const chat = await slackChat.create({
        options: slackChat.options.parse({}),
        secrets: envSecretSource(),
        team: { people: [] } as unknown as TeamConfig,
        log: silentLogger,
        fetch,
        now: () => new Date(),
      });

      const channel = await chat.openDirect(user!);
      const first = await chat.post(channel, "**outstaff** live test");
      const reply = await chat.post(channel, "a reply", { thread: first.thread });
      await chat.react(channel, first.id, "done");
      const thread = await chat.history(channel, { thread: first.thread, limit: 10 });
      expect(thread.map((m) => m.id)).toEqual([first.id, reply.id]);
      await chat.setAgentProfile!(user!, {
        name: "Test",
        role: "developer",
        status: "idle",
      });
    });
  },
);
