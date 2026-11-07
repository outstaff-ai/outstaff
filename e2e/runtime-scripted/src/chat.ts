import {
  defineAdapter,
  type Chat,
  type ChatFile,
  type ChatMessage,
  type ChatMissed,
  type ChatMissedOptions,
} from "@outstaff/core";
import { z } from "zod";

const POLL_MS = 500;

interface Inbound {
  seq: number;
  id: string;
  channel: string;
  thread?: string;
  authorId: string;
  authorName: string;
  trusted: boolean;
  text: string;
  at: string;
  files?: ChatFile[];
}

const messageOf = (m: Inbound): ChatMessage => ({
  id: m.id,
  channel: m.channel,
  ...(m.thread ? { thread: m.thread } : {}),
  author: { id: m.authorId, name: m.authorName, trusted: m.trusted, bot: false },
  text: m.text,
  at: m.at,
  ...(m.files ? { files: m.files } : {}),
});

const keyOf = (c: { channel: string; thread?: string | undefined }) =>
  `${c.channel}:${c.thread ?? ""}`;

/** The messages after each conversation's cursor, else since the window: the latest `limit`, and how many are not. */
function missedIn(messages: ChatMessage[], opts: ChatMissedOptions): ChatMissed[] {
  const cursors = new Map(opts.cursors.map((c) => [keyOf(c), c.at]));
  const groups = new Map<string, ChatMessage[]>();
  for (const m of messages.filter((x) => x.at > (cursors.get(keyOf(x)) ?? opts.since))) {
    groups.set(keyOf(m), [...(groups.get(keyOf(m)) ?? []), m]);
  }

  return [...groups.values()].map((all) => {
    const kept = all.filter((m) => m.at >= opts.since).slice(-opts.limit);
    return {
      channel: all[0]!.channel,
      ...(all[0]!.thread ? { thread: all[0]!.thread } : {}),
      messages: kept,
      skipped: all.length - kept.length,
    };
  });
}

/**
 * A chat for the end-to-end test: the messages one trusted human (or, when the driver says so, an untrusted guest)
 * writes to `agent` come from the stub workspace over HTTP, and what the agent posts goes there as the agent's.
 */
export function createStubChat(baseUrl: string, agent: string): Chat {
  let timer: NodeJS.Timeout | undefined;
  let after = 0;
  let busy = false;

  const call = async <T>(path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });

    if (!res.ok) {
      throw new Error(`${path}: ${res.status}`);
    }

    return (await res.json()) as T;
  };

  const inbox = async (from: number) =>
    (await call<{ messages: Inbound[] }>(`/chat/inbox?after=${from}&agent=${agent}`)).messages;

  return {
    async start(onMessage) {
      // Like Socket Mode, only what is written from now on is delivered; what came before is caught up on. Without
      // the stub's answer every message is delivered again, and the office recognizes the ones it has.
      const head = await inbox(0).catch((): Inbound[] => []);
      after = Math.max(after, ...head.map((m) => m.seq));
      timer = setInterval(() => {
        if (busy) {
          return;
        }

        busy = true;
        void inbox(after)
          .then(async (messages) => {
            for (const m of messages) {
              after = Math.max(after, m.seq);
              await onMessage(messageOf(m));
            }
          })
          .catch(() => {})
          .finally(() => {
            busy = false;
          });
      }, POLL_MS);
    },

    async stop() {
      clearInterval(timer);
    },

    post: (channel, markdown, opts) =>
      call("/chat/post", {
        agent,
        channel,
        text: markdown,
        ...(opts?.thread ? { thread: opts.thread } : {}),
      }),

    async react(channel, messageId, name) {
      await call("/chat/react", { channel, messageId, name });
    },

    async history(channel, opts) {
      const query = new URLSearchParams({ channel, limit: String(opts.limit) });
      if (opts.thread) {
        query.set("thread", opts.thread);
      }

      return (await call<{ messages: ChatMessage[] }>(`/chat/history?${query}`)).messages;
    },

    async download(file) {
      const res = await fetch(`${baseUrl}${file.url}`);
      if (!res.ok) {
        throw new Error(`${file.url}: ${res.status}`);
      }

      return new Uint8Array(await res.arrayBuffer());
    },

    // The stub workspace is the human's direct messages with the agent: each conversation after its cursor.
    async missedSince(opts) {
      return missedIn((await inbox(0)).filter((m) => m.trusted).map(messageOf), opts);
    },

    openDirect: async (userId) => `D-${agent}-${userId}`,

    async setAgentProfile(userId, profile) {
      await call("/chat/profile", { agent, userId, profile });
    },
  };
}

/**
 * Takes the place of the Slack adapter in the agent-e2e image, under its name, so the team file stays as it is.
 * `E2E_STUB_URL` is where the stub workspace listens; the agent reads the messages written to it (`OUTSTAFF_PERSON`).
 * `E2E_CHAT=off` starts an agent without chat.
 */
export const stubChat = defineAdapter({
  port: "chat",
  name: "slack",
  capabilities: [
    "chat.messages",
    "chat.history",
    "chat.agentProfile",
    "chat.files",
    "chat.catchUp",
  ],
  options: z.strictObject({}),
  secrets: () => [],
  unavailableFor: () =>
    process.env["E2E_CHAT"] === "off" ? "this agent has no chat in the end-to-end run" : undefined,
  create: () =>
    createStubChat(
      process.env["E2E_STUB_URL"] ?? "http://tracker.acme.example:8081",
      process.env["OUTSTAFF_PERSON"] ?? "sam",
    ),
});
