import type { ChatMessage } from "@outstaff/core";
import { PortError } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { slackChat } from "./index.js";
import { createSlackChat } from "./chat.js";
import { silentLogger } from "@outstaff/core";
import { secretMap, slackWith, teamWith } from "./testing/harness.js";
import { BOT_USER, slackError } from "./testing/slack-fake.js";

async function started(humans?: string[]) {
  const s = slackWith(teamWith(humans));
  const received: ChatMessage[] = [];
  await s.chat.start(async (m) => void received.push(m));
  return { ...s, received };
}

describe("adapter definition", () => {
  it("declares the chat capabilities and the person secrets", () => {
    expect(slackChat.port).toBe("chat");
    expect(slackChat.name).toBe("slack");
    expect(slackChat.capabilities).toEqual(["chat.messages", "chat.history", "chat.agentProfile"]);
    const secrets = slackChat.secrets("person");
    expect(secrets.map((s) => s.key)).toEqual([
      "SLACK_BOT_TOKEN",
      "SLACK_APP_TOKEN",
      "SLACK_BOT_USER_ID",
    ]);

    expect(secrets.find((s) => s.key === "SLACK_BOT_USER_ID")).toMatchObject({
      derivable: true,
      optional: true,
    });

    expect(slackChat.secrets("office").map((s) => s.key)).toEqual(["SLACK_OFFICE_BOT_TOKEN"]);
    expect(slackChat.options.parse({})).toEqual({});
  });
});

describe("trust filter", () => {
  it("trusts a full member by default and ignores a guest", async () => {
    const { fake, received } = await started();
    fake.users.set("U-noor", { id: "U-noor", name: "noor" });
    fake.users.set("U-guest", { id: "U-guest", name: "guest", is_restricted: true });
    fake.users.set("U-single", { id: "U-single", name: "single", is_ultra_restricted: true });
    await fake.directMessage("U-noor", "hello");
    await fake.directMessage("U-guest", "let me in");
    await fake.directMessage("U-single", "me too");
    expect(received.map((m) => [m.author.id, m.author.trusted])).toEqual([["U-noor", true]]);
  });

  it("ignores bots, deactivated users and its own messages", async () => {
    const { fake, received } = await started();
    fake.users.set("U-app", { id: "U-app", name: "other", is_bot: true });
    fake.users.set("U-gone", { id: "U-gone", name: "gone", deleted: true });
    await fake.directMessage("U-app", "beep");
    await fake.directMessage("U-gone", "ghost");
    await fake.directMessage(BOT_USER, "echo");
    await fake.directMessage("U-x", "with bot id", { bot_id: "B1" });
    expect(received).toEqual([]);
  });

  it("with a humans list, trusts only an exact listed member id", async () => {
    const { fake, received } = await started(["U0NOOR001", "U0SAM0001"]);
    fake.users.set("U0NOOR001", { id: "U0NOOR001", name: "noor" });
    fake.users.set("U0KIT0001", { id: "U0KIT0001", name: "kit" });
    await fake.directMessage("U0NOOR001", "by id");
    await fake.directMessage("U0KIT0001", "a full member who is not listed");
    expect(received.map((m) => m.text)).toEqual(["by id"]);
  });

  it("never trusts a name that equals a listed id or name", async () => {
    const { fake, received } = await started(["U0NOOR001", "noor"]);
    fake.users.set("U0EVIL001", {
      id: "U0EVIL001",
      name: "U0NOOR001",
      real_name: "noor",
      profile: { display_name: "U0NOOR001" },
    });

    fake.users.set("U0EVIL002", {
      id: "U0EVIL002",
      name: "noor",
      profile: { display_name: "noor" },
    });

    await fake.directMessage("U0EVIL001", "impersonation");
    await fake.directMessage("U0EVIL002", "impersonation by name");
    expect(received).toEqual([]);
  });

  it("warns about an identity that is not a member id and does not match it", async () => {
    const warnings: string[] = [];
    const s = slackWith(teamWith(["@noor"]), (m) => warnings.push(m));
    const received: ChatMessage[] = [];
    await s.chat.start(async (m) => void received.push(m));
    s.fake.users.set("U0NOOR001", { id: "U0NOOR001", name: "noor" });
    await s.fake.directMessage("U0NOOR001", "hi");
    expect(received).toEqual([]);
    expect(warnings.join()).toContain("not a Slack member id");
  });

  it("a humans list does not trust a listed bot", async () => {
    const { fake, received } = await started(["U0APP0001"]);
    fake.users.set("U0APP0001", { id: "U0APP0001", name: "app", is_bot: true });
    await fake.directMessage("U0APP0001", "beep");
    expect(received).toEqual([]);
  });

  it("treats a failed lookup as untrusted and does not cache it", async () => {
    const { fake, received } = await started();
    await fake.directMessage("U-late", "first");
    expect(received).toEqual([]);
    fake.users.set("U-late", { id: "U-late", name: "late" });
    await fake.directMessage("U-late", "second");
    expect(received.map((m) => m.text)).toEqual(["second"]);
  });

  it("caches lookups", async () => {
    const { fake, received } = await started();
    fake.users.set("U-noor", { id: "U-noor", name: "noor" });
    await fake.directMessage("U-noor", "one");
    await fake.directMessage("U-noor", "two");
    expect(received).toHaveLength(2);
    expect(fake.usersInfoCalls.filter((u) => u === "U-noor")).toHaveLength(1);
  });
});

describe("inbound events", () => {
  it("takes direct messages and mentions only", async () => {
    const { fake, received } = await started();
    fake.users.set("U-noor", { id: "U-noor", name: "noor" });
    const base = { user: "U-noor", ts: "1.1", text: "hi" };
    await fake.emit({ type: "message", channel_type: "channel", channel: "C1", ...base });
    await fake.emit({
      type: "message",
      channel_type: "im",
      channel: "D1",
      subtype: "message_changed",
      ...base,
    });

    await fake.emit({ type: "reaction_added", channel: "D1", ...base });
    expect(received).toEqual([]);
    await fake.emit({
      type: "app_mention",
      channel: "C1",
      ...base,
      ts: "1.2",
      text: `<@${BOT_USER}> status?`,
    });

    expect(received).toMatchObject([{ channel: "C1", text: "status?", id: "1.2" }]);
  });

  it("keeps the thread of a reply and delivers each message once", async () => {
    const { fake, received } = await started();
    fake.users.set("U-noor", { id: "U-noor", name: "noor" });
    const event = {
      type: "message",
      channel_type: "im",
      channel: "D1",
      user: "U-noor",
      ts: "5.5",
      thread_ts: "5.0",
      text: "in thread",
    };

    await fake.emit(event);
    await fake.emit(event);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ thread: "5.0", author: { name: "noor", trusted: true } });
    expect(received[0]?.at).toBe(new Date(5.5 * 1000).toISOString());
  });

  it("survives a handler that throws", async () => {
    const s = slackWith();
    s.fake.users.set("U-noor", { id: "U-noor", name: "noor" });
    await s.chat.start(async () => {
      throw new Error("boom");
    });

    await expect(s.fake.directMessage("U-noor", "hi")).resolves.toBeUndefined();
  });
});

describe("posting", () => {
  it("converts markdown to mrkdwn", async () => {
    const { fake, chat } = await started();
    await chat.post("C1", "## Done\n**ACME-1** shipped");
    expect(fake.posts).toEqual([{ channel: "C1", text: "*Done*\n*ACME-1* shipped" }]);
  });

  it("splits long text into several messages in one thread", async () => {
    const { fake, chat } = await started();
    const text = Array.from({ length: 1000 }, (_, i) => `line ${i} of a long report`).join("\n");
    const sent = await chat.post("C1", text);
    expect(fake.posts.length).toBeGreaterThan(5);
    expect(fake.posts.every((p) => p.text.length <= 3500)).toBe(true);
    expect(fake.posts[0]?.thread_ts).toBeUndefined();
    expect(new Set(fake.posts.slice(1).map((p) => p.thread_ts))).toEqual(new Set([sent.thread]));
    expect(fake.posts.map((p) => p.text).join("\n")).toBe(text);
  });

  it("replies into the given thread", async () => {
    const { fake, chat } = await started();
    const sent = await chat.post("C1", "reply", { thread: "9.9" });
    expect(sent.thread).toBe("9.9");
    expect(fake.posts[0]?.thread_ts).toBe("9.9");
  });

  it("maps reactions to Slack emoji and tolerates a repeat", async () => {
    const { fake, chat } = await started();
    const { id } = await chat.post("C1", "x");
    await chat.react("C1", id, "eyes");
    await chat.react("C1", id, "done");
    await chat.react("C1", id, "error");
    await chat.react("C1", id, "done");
    expect(fake.reactions.map((r) => r.name)).toEqual(["eyes", "white_check_mark", "x"]);
  });

  it("maps Slack errors to port errors", async () => {
    const { fake, chat } = await started();
    fake.web.chat.postMessage = async () => {
      throw slackError("not_in_channel");
    };

    await expect(chat.post("C1", "x")).rejects.toMatchObject({ code: "forbidden" });
    fake.web.chat.postMessage = async () => {
      throw Object.assign(new Error("rate"), {
        code: "slack_webapi_rate_limited_error",
        retryAfter: 3,
      });
    };

    const error = await chat.post("C1", "x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PortError);
    expect(error).toMatchObject({ code: "rate_limited", retryAfterMs: 3000 });
  });
});

describe("history", () => {
  it("returns channel history oldest first, limited, with senders resolved", async () => {
    const { fake, chat } = await started();
    fake.users.set("U-noor", { id: "U-noor", name: "noor" });
    await fake.seed.inbound({ channel: "C1", authorId: "U-noor", text: "a" });
    await fake.seed.inbound({ channel: "C1", authorId: "U-noor", text: "b" });
    await chat.post("C1", "c");
    const last2 = await chat.history("C1", { limit: 2 });
    expect(last2.map((m) => m.text)).toEqual(["b", "c"]);
    expect(last2.map((m) => [m.author.bot, m.author.trusted])).toEqual([
      [false, true],
      [true, true],
    ]);
  });

  it("pages through a long thread to find its newest messages", async () => {
    const { fake, chat } = await started();
    const first = await chat.post("C1", "m0");
    for (let i = 1; i <= 250; i++) {
      await chat.post("C1", `m${i}`, { thread: first.thread });
    }

    const tail = await chat.history("C1", { thread: first.thread, limit: 3 });
    expect(tail.map((m) => m.text)).toEqual(["m248", "m249", "m250"]);
    expect(fake.posts).toHaveLength(251);
  });
});

describe("direct channels and profile", () => {
  it("opens and remembers the direct channel", async () => {
    const { chat } = await started();
    expect(await chat.openDirect("U-noor")).toBe("D-U-noor");
  });

  const texts = (view: { blocks: Record<string, any>[] }) =>
    view.blocks.map((b) => b["text"]?.text ?? b["type"]);

  it("publishes the profile as a Home tab and republishes it when the tab opens", async () => {
    const { fake, chat } = await started();
    await chat.setAgentProfile!("U-noor", {
      name: "Sam",
      role: "developer",
      status: "working",
      current: { title: "ACME-1 Fix <checkout>", url: "https://acme.example/1" },
      sections: [{ heading: "Waiting on", lines: ["**noor**: review"] }],
    });

    expect(fake.views).toHaveLength(1);
    expect(fake.views[0]?.user_id).toBe("U-noor");
    expect(texts(fake.views[0]!.view)).toEqual([
      "Sam",
      "*developer*",
      ":large_green_circle: *Working on* <https://acme.example/1|ACME-1 Fix &lt;checkout&gt;>",
      "divider",
      "*Waiting on*\n*noor*: review",
    ]);

    await fake.emit({ type: "app_home_opened", tab: "home", user: "U-noor" });
    await fake.emit({ type: "app_home_opened", tab: "messages", user: "U-noor" });
    await fake.emit({ type: "app_home_opened", tab: "home", user: "U-other" });
    expect(fake.views).toHaveLength(2);
  });

  it("renders a working status, the grouped work, the hint and the time in the viewer's timezone", async () => {
    const { fake, chat } = await started();
    fake.users.set("U-noor", { id: "U-noor", name: "noor", tz: "Europe/Berlin" });
    await chat.setAgentProfile!("U-noor", {
      name: "Sam",
      role: "Developer",
      description: "Builds features.",
      model: "sonnet",
      status: "working",
      current: { title: "ACME-1 Checkout", url: "https://t.acme.example/ACME-1" },
      lastActiveAt: "2026-01-01T10:05:00Z",
      hint: "**Talk to me here.** Ask a question and I answer right away.",
      sections: [
        {
          heading: "Current work",
          lines: [
            "1. [ACME-1 Checkout](https://t.acme.example/ACME-1) (running: addressing review on [PR #4](https://git.acme.example/acme/shop/pull/4))",
            "2. [ACME-2 Cart](https://t.acme.example/ACME-2)",
          ],
        },
      ],
    });

    expect(texts(fake.views[0]!.view)).toEqual([
      "Sam",
      "*Developer*\nBuilds features.\n_Model: sonnet_",
      ":large_green_circle: *Working on* <https://t.acme.example/ACME-1|ACME-1 Checkout>\n_Last active 1 Jan 2026, 11:05 CET_",
      "*Talk to me here.* Ask a question and I answer right away.",
      "divider",
      "*Current work*\n1. <https://t.acme.example/ACME-1|ACME-1 Checkout> (running: addressing review on <https://git.acme.example/acme/shop/pull/4|PR #4>)\n2. <https://t.acme.example/ACME-2|ACME-2 Cart>",
    ]);
  });

  it("renders idle with the last active time in UTC when the timezone is unknown", async () => {
    const { fake, chat } = await started();
    await chat.setAgentProfile!("U-noor", {
      name: "Sam",
      role: "Developer",
      status: "idle",
      lastActiveAt: "2026-01-01T10:05:00Z",
      sections: [{ heading: "Current work", lines: [] }],
    });

    expect(texts(fake.views[0]!.view)).toEqual([
      "Sam",
      "*Developer*",
      ":white_circle: *Idle*\n_Last active 1 Jan 2026, 10:05 UTC_",
      "divider",
      "*Current work*\n_Nothing._",
    ]);
  });

  it("asks for a fresh profile when the tab opens and the held one is over a minute old", async () => {
    let at = new Date("2026-01-01T00:00:00Z");
    const s = slackWith(teamWith(), undefined, () => at);
    await s.chat.start(async () => {});
    s.fake.users.set("U-noor", { id: "U-noor", name: "noor" });
    const asked: string[] = [];
    s.chat.onProfileRequest!(async (user) => {
      asked.push(user);
      return { name: "Sam", role: "Developer", status: "idle" };
    });

    await s.chat.setAgentProfile!("U-noor", { name: "Sam", role: "Developer", status: "working" });
    at = new Date("2026-01-01T00:00:30Z");
    await s.fake.emit({ type: "app_home_opened", tab: "home", user: "U-noor" });
    expect(asked).toEqual([]);
    expect(s.fake.views).toHaveLength(2);

    at = new Date("2026-01-01T00:02:00Z");
    await s.fake.emit({ type: "app_home_opened", tab: "home", user: "U-noor" });
    expect(asked).toEqual(["U-noor"]);
    expect(texts(s.fake.views[2]!.view)[2]).toBe(":white_circle: *Idle*");
  });

  it("does not publish to an untrusted person who opens the tab", async () => {
    const s = slackWith(teamWith(["U-noor"]));
    await s.chat.start(async () => {});
    s.fake.users.set("U-guest", { id: "U-guest", name: "guest" });
    s.chat.onProfileRequest!(async () => ({ name: "Sam", role: "Developer", status: "idle" }));
    await s.fake.emit({ type: "app_home_opened", tab: "home", user: "U-guest" });
    expect(s.fake.views).toHaveLength(0);
  });
});

describe("lifecycle", () => {
  it("starts and stops the socket", async () => {
    const { fake, chat } = await started();
    expect(fake.socket.started).toBe(true);
    await chat.stop();
    expect(fake.socket.started).toBe(false);
  });
});

describe("office scope", () => {
  const officeCtx = (values: Record<string, string>) => ({
    options: {},
    secrets: secretMap(values),
    team: teamWith(),
    scope: "office" as const,
    log: silentLogger,
    fetch,
    now: () => new Date("2026-01-01T00:00:00Z"),
  });

  it("names the missing office token instead of staying silent", () => {
    expect(() => createSlackChat(officeCtx({ SLACK_BOT_TOKEN: "xoxb-agent" }))).toThrow(
      /SLACK_OFFICE_BOT_TOKEN/,
    );
  });

  it("reads the office token and needs no app token", () => {
    expect(() =>
      createSlackChat(officeCtx({ SLACK_OFFICE_BOT_TOKEN: "xoxb-office" })),
    ).not.toThrow();
  });

  it("never listens", async () => {
    const chat = createSlackChat(officeCtx({ SLACK_OFFICE_BOT_TOKEN: "xoxb-office" }));
    await expect(chat.start(async () => {})).rejects.toThrow(/never listens/);
  });

  it("keeps requiring the person token for an agent", () => {
    expect(() =>
      createSlackChat({ ...officeCtx({ SLACK_OFFICE_BOT_TOKEN: "x" }), scope: "person" }),
    ).toThrow(/SLACK_BOT_TOKEN/);
  });
});
