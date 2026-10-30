import { defineAdapter, type Chat, type ChatFile, type ChatMessage } from "@outstaff/core";
import { z } from "zod";

const POLL_MS = 500;

interface Inbound {
  seq: number;
  id: string;
  channel: string;
  thread?: string;
  authorId: string;
  authorName: string;
  text: string;
  at: string;
  files?: ChatFile[];
}

/** A chat for the end-to-end test: the messages of one trusted human come from the stub workspace over HTTP. */
export function createStubChat(baseUrl: string): Chat {
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

  return {
    async start(onMessage) {
      timer = setInterval(() => {
        if (busy) {
          return;
        }

        busy = true;
        void call<{ messages: Inbound[] }>(`/chat/inbox?after=${after}`)
          .then(async ({ messages }) => {
            for (const m of messages) {
              after = Math.max(after, m.seq);
              const message: ChatMessage = {
                id: m.id,
                channel: m.channel,
                ...(m.thread ? { thread: m.thread } : {}),
                author: { id: m.authorId, name: m.authorName, trusted: true, bot: false },
                text: m.text,
                at: m.at,
                ...(m.files ? { files: m.files } : {}),
              };

              await onMessage(message);
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

    openDirect: async (userId) => `D-${userId}`,

    async setAgentProfile(userId, profile) {
      await call("/chat/profile", { userId, profile });
    },
  };
}

/**
 * Takes the place of the Slack adapter in the agent-e2e image, under its name, so the team file stays as it is.
 * `E2E_STUB_URL` is where the stub workspace listens. The workspace has one inbox for everyone, so only one agent may
 * read it: `E2E_CHAT=off` starts an agent without chat.
 */
export const stubChat = defineAdapter({
  port: "chat",
  name: "slack",
  capabilities: ["chat.messages", "chat.history", "chat.agentProfile", "chat.files"],
  options: z.strictObject({}),
  secrets: () => [],
  unavailableFor: () =>
    process.env["E2E_CHAT"] === "off" ? "this agent has no chat in the end-to-end run" : undefined,
  create: () => createStubChat(process.env["E2E_STUB_URL"] ?? "http://tracker.acme.example:8081"),
});
