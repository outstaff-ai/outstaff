import { PortError, silentLogger, type AdapterContext, type ChatMessage } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { createSlackChat } from "../chat.js";
import type { SlackEvent, SlackMessage } from "../api.js";
import type { SlackOptions } from "../options.js";
import { secretMap, slackWith, teamWith } from "../testing/harness.js";
import { BOT_USER, createFakeSlack, slackError } from "../testing/slack-fake.js";

async function started(now?: () => Date, onWarn?: (m: string) => void) {
  const s = slackWith(teamWith(), onWarn, now);
  const received: ChatMessage[] = [];
  await s.chat.start(async (m) => void received.push(m));
  s.fake.users.set("U-noor", { id: "U-noor", name: "noor" });
  return { ...s, received };
}

const dm = (over: Partial<SlackEvent> = {}): SlackEvent => ({
  type: "message",
  channel_type: "im",
  channel: "D1",
  user: "U-noor",
  ts: "10.1",
  text: "hi",
  ...over,
});

describe("files in a message", () => {
  it("falls back through the file's address, name and type", async () => {
    const { fake, received } = await started();
    await fake.emit(
      dm({
        subtype: "file_share",
        files: [
          { id: "F1", url_private: "https://files.slack.com/a", title: "A title" },
          { id: "F2", url_private_download: "https://files.slack.com/b" },
          { id: "F3", name: "c.png", mimetype: "image/png", size: 7, url_private: "https://x/c" },
          { name: "no-id.png", url_private: "https://files.slack.com/d" },
        ],
      }),
    );

    expect(received[0]?.files).toEqual([
      {
        id: "F1",
        name: "A title",
        mimetype: "application/octet-stream",
        size: 0,
        url: "https://files.slack.com/a",
      },
      {
        id: "F2",
        name: "F2",
        mimetype: "application/octet-stream",
        size: 0,
        url: "https://files.slack.com/b",
      },
      { id: "F3", name: "c.png", mimetype: "image/png", size: 7, url: "https://x/c" },
    ]);
  });
});

describe("download", () => {
  const file = {
    id: "F1",
    name: "a.png",
    mimetype: "image/png",
    size: 3,
    url: "https://files.slack.com/files-pri/T0-F1/download/a.png",
  };

  const withFetch = (fetchImpl: typeof fetch) => {
    const fake = createFakeSlack();
    return createSlackChat(
      {
        options: {},
        secrets: secretMap({ SLACK_BOT_TOKEN: "xoxb-1" }),
        team: teamWith(),
        log: silentLogger,
        fetch: fetchImpl,
        now: () => new Date(),
      },
      { web: fake.web, socket: fake.socket },
    );
  };

  it("reports an unreachable Slack as unavailable, keeping the cause", async () => {
    const cause = new Error("offline");
    const chat = withFetch((async () => {
      throw cause;
    }) as typeof fetch);

    const error = await chat.download!(file).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PortError);
    expect(error).toMatchObject({ code: "unavailable", cause });
  });

  it("maps a refused token to forbidden and any other failure to unavailable", async () => {
    for (const [status, code] of [
      [401, "forbidden"],
      [403, "forbidden"],
      [404, "unavailable"],
      [500, "unavailable"],
    ] as const) {
      const chat = withFetch((async () => new Response("no", { status })) as typeof fetch);
      await expect(chat.download!(file)).rejects.toMatchObject({ code });
    }
  });

  it("returns a web page when that is what the file is, and a body with no content type", async () => {
    const html = withFetch(
      (async () =>
        new Response("<html>page</html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        })) as typeof fetch,
    );

    const page = await html.download!({ ...file, mimetype: "text/html" });
    expect(new TextDecoder().decode(page)).toBe("<html>page</html>");

    const bare = withFetch((async () => new Response(new Uint8Array([1, 2, 3]))) as typeof fetch);
    expect([...(await bare.download!(file))]).toEqual([1, 2, 3]);
  });

  it("sends an empty bearer when the client was injected and no token is configured", async () => {
    let authorization: string | null = null;
    const fake = createFakeSlack();
    const chat = createSlackChat(
      {
        options: {},
        secrets: secretMap({}),
        team: teamWith(),
        log: silentLogger,
        fetch: (async (_url: URL, init: RequestInit) => {
          authorization = new Headers(init.headers).get("authorization");
          return new Response(new Uint8Array([9]));
        }) as unknown as typeof fetch,
        now: () => new Date(),
      } satisfies AdapterContext<SlackOptions>,
      { web: fake.web },
    );

    await chat.download!(file);
    expect(authorization).toBe("Bearer");
  });
});

describe("message senders and text", () => {
  it("reads history without the bot's id by trimming, and an empty text as empty", async () => {
    const s = slackWith();
    s.fake.web.auth.test = async () => ({});
    s.fake.web.conversations.history = async () => ({
      messages: [{ ts: "3.1" }, { ts: "2.1", user: "U-noor", text: "  <@U1> spoken  " }],
    });

    s.fake.users.set("U-noor", { id: "U-noor", name: "noor" });
    const messages = await s.chat.history("C1", { limit: 5 });
    expect(messages.map((m) => m.text)).toEqual(["<@U1> spoken", ""]);
  });

  it("removes the bot's own mention from the text and reads an empty text as empty", async () => {
    const s = slackWith();
    s.fake.users.set("U-noor", { id: "U-noor", name: "noor" });
    s.fake.web.conversations.history = async () => ({
      messages: [
        { ts: "3.1", user: "U-noor" },
        { ts: "2.1", user: "U-noor", text: `<@${BOT_USER}> hey` },
      ],
    });

    const messages = await s.chat.history("C1", { limit: 5 });
    expect(messages.map((m) => m.text)).toEqual(["hey", ""]);
  });

  it("tells apart a message with no author, a bot app's, and the agent's own", async () => {
    const s = slackWith();
    const rows: SlackMessage[] = [
      { ts: "4.1", user: BOT_USER, text: "mine" },
      { ts: "3.1", bot_id: "B-other", text: "app" },
      { ts: "2.1", text: "nobody" },
    ];

    s.fake.web.conversations.history = async () => ({ messages: rows });
    const authors = (await s.chat.history("C1", { limit: 5 })).map((m) => m.author);
    expect(authors).toEqual([
      { id: "unknown", trusted: false, bot: true },
      { id: "B-other", trusted: false, bot: true },
      { id: BOT_USER, trusted: true, bot: true },
    ]);
  });
});

describe("delivery of events", () => {
  it("forgets the oldest of 500 delivered messages, so only recent repeats are dropped", async () => {
    const { fake, received } = await started();
    for (let i = 0; i < 501; i++) {
      await fake.emit(dm({ ts: `${i + 1}.0`, text: `m${i}` }));
    }

    expect(received).toHaveLength(501);
    await fake.emit(dm({ ts: "501.0", text: "m500" }));
    expect(received).toHaveLength(501);
    await fake.emit(dm({ ts: "1.0", text: "m0" }));
    expect(received).toHaveLength(502);
  });

  it("reports a socket that fails to start as a port error", async () => {
    const s = slackWith();
    s.fake.socket.start = async () => {
      throw slackError("invalid_auth");
    };

    await expect(s.chat.start(async () => {})).rejects.toMatchObject({ code: "forbidden" });
  });

  it("does nothing on stop when it never started", async () => {
    const fake = createFakeSlack();
    const chat = createSlackChat(
      {
        options: {},
        secrets: secretMap({ SLACK_BOT_TOKEN: "xoxb-1" }),
        team: teamWith(),
        log: silentLogger,
        fetch,
        now: () => new Date(),
      },
      { web: fake.web },
    );

    await expect(chat.stop()).resolves.toBeUndefined();
  });
});

describe("posting and direct channels", () => {
  it("fails when Slack returns no timestamp, and posts nothing further", async () => {
    const s = slackWith();
    s.fake.web.chat.postMessage = async () => ({});
    await expect(s.chat.post("C1", "x")).rejects.toMatchObject({
      code: "unavailable",
      message: "Slack did not return a message timestamp.",
    });
  });

  it("fails when Slack opens no direct channel, and asks again next time", async () => {
    const s = slackWith();
    let calls = 0;
    s.fake.web.conversations.open = async () => {
      calls++;
      return calls === 1 ? {} : { channel: { id: "D9" } };
    };

    await expect(s.chat.openDirect("U-noor")).rejects.toMatchObject({ code: "unavailable" });
    expect(await s.chat.openDirect("U-noor")).toBe("D9");
    expect(await s.chat.openDirect("U-noor")).toBe("D9");
    expect(calls).toBe(2);
  });
});

describe("history paging", () => {
  it("asks for at most 200 at a time and returns the newest messages oldest first", async () => {
    const s = slackWith();
    const asked: (number | undefined)[] = [];
    const original = s.fake.web.conversations.history;
    s.fake.web.conversations.history = async (args) => {
      asked.push(args.limit);
      return original(args);
    };

    for (let i = 0; i < 230; i++) {
      await s.fake.web.chat.postMessage({ channel: "C1", text: `m${i}` });
    }

    const messages = await s.chat.history("C1", { limit: 220 });
    expect(asked[0]).toBe(200);
    expect(messages).toHaveLength(220);
    expect(messages[0]?.text).toBe("m10");
    expect(messages.at(-1)?.text).toBe("m229");
  });

  it("returns nothing for a page with no messages", async () => {
    const s = slackWith();
    s.fake.web.conversations.history = async () => ({});
    s.fake.web.conversations.replies = async () => ({});
    expect(await s.chat.history("C1", { limit: 5 })).toEqual([]);
    expect(await s.chat.history("C1", { limit: 5, thread: "1.1" })).toEqual([]);
  });
});

describe("the Home tab", () => {
  const profile = { name: "Sam", role: "Developer", status: "idle" } as const;
  const texts = (view: { blocks: Record<string, any>[] }) =>
    view.blocks.map((b) => b["text"]?.text ?? b["type"]);

  it("publishes nothing when the agent has no profile to give a trusted person", async () => {
    const s = await started();
    s.chat.onProfileRequest!(async () => undefined);
    await s.fake.emit({ type: "app_home_opened", tab: "home", user: "U-noor" });
    expect(s.fake.views).toEqual([]);
  });

  it("shows the profile it holds when refreshing fails, and logs why", async () => {
    let at = new Date("2026-01-01T00:00:00Z");
    const warnings: string[] = [];
    const s = await started(
      () => at,
      (m) => warnings.push(m),
    );

    await s.chat.setAgentProfile!("U-noor", { ...profile, status: "working" });
    s.chat.onProfileRequest!(async () => {
      throw new Error("agent busy");
    });

    at = new Date("2026-01-01T00:05:00Z");
    await s.fake.emit({ type: "app_home_opened", tab: "home", user: "U-noor" });
    expect(warnings).toEqual(["could not refresh the profile; showing the one held"]);
    expect(s.fake.views).toHaveLength(2);
    expect(texts(s.fake.views[1]!.view)[2]).toBe(":large_green_circle: *Working*");
  });

  it("publishes a profile for a trusted person who had none, and holds it", async () => {
    const s = await started();
    let asked = 0;
    s.chat.onProfileRequest!(async () => {
      asked++;
      return profile;
    });

    await s.fake.emit({ type: "app_home_opened", tab: "home", user: "U-noor" });
    await s.fake.emit({ type: "app_home_opened", tab: "home", user: "U-noor" });
    expect(asked).toBe(1);
    expect(s.fake.views).toHaveLength(2);
  });

  it("looks a viewer's timezone up once for ten minutes, and shows UTC when it is blank or unknown", async () => {
    let at = new Date("2026-01-01T00:00:00Z");
    const s = await started(() => at);
    const active = { ...profile, lastActiveAt: "2026-01-01T10:05:00Z" };
    s.fake.users.set("U-noor", { id: "U-noor", name: "noor", tz: "Asia/Tokyo" });
    s.fake.users.set("U-blank", { id: "U-blank", name: "blank", tz: "" });
    const looked = () => s.fake.usersInfoCalls.filter((u) => u === "U-noor").length;
    await s.chat.setAgentProfile!("U-noor", active);
    await s.chat.setAgentProfile!("U-noor", active);
    expect(looked()).toBe(1);
    expect(texts(s.fake.views[1]!.view)[2]).toContain("19:05 GMT+9");

    at = new Date("2026-01-01T00:10:00Z");
    await s.chat.setAgentProfile!("U-noor", active);
    expect(looked()).toBe(2);

    await s.chat.setAgentProfile!("U-blank", active);
    await s.chat.setAgentProfile!("U-ghost", active);
    expect(texts(s.fake.views[3]!.view)[2]).toContain("10:05 UTC");
    expect(texts(s.fake.views[4]!.view)[2]).toContain("10:05 UTC");
  });
});
