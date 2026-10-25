import type { Route } from "./http.ts";

/**
 * A chat workspace for the end-to-end test: the agent's chat adapter polls it (e2e/runtime-scripted/src/chat.ts), and
 * the driver speaks in it as a trusted human of the acme team. Gates hold a scripted round until the driver opens
 * them, so the test can talk to the agent while a round is still running.
 */

interface Message {
  seq: number;
  id: string;
  channel: string;
  thread?: string;
  authorId: string;
  authorName: string;
  text: string;
  at: string;
}

export const HUMAN = { id: "U0ADA00001", name: "Ada Admin" };
export const DIRECT = "D-U0ADA00001";

export function createChat() {
  const messages: Message[] = [];
  const posts: { id: string; channel: string; thread?: string; text: string; at: string }[] = [];
  const reactions: { channel: string; messageId: string; name: string }[] = [];
  const gates = new Map<string, { open: boolean; arrived: boolean }>();
  let counter = 0;
  const id = () => `${Date.now()}.${String(++counter).padStart(4, "0")}`;
  const gate = (name: string) => {
    let g = gates.get(name);
    if (!g) {
      g = { open: true, arrived: false };
      gates.set(name, g);
    }

    return g;
  };

  const routes: Route[] = [
    {
      method: "GET",
      path: "/chat/inbox",
      handler: (r) => ({
        messages: messages.filter((m) => m.seq > Number(r.query.get("after") ?? 0)),
      }),
    },
    {
      method: "POST",
      path: "/chat/post",
      handler: (r) => {
        const post = {
          id: id(),
          channel: r.json.channel,
          ...(r.json.thread ? { thread: r.json.thread } : {}),
          text: r.json.text,
          at: new Date().toISOString(),
        };

        posts.push(post);
        return { id: post.id, thread: post.thread ?? post.id };
      },
    },
    {
      method: "POST",
      path: "/chat/react",
      handler: (r) => {
        reactions.push({ channel: r.json.channel, messageId: r.json.messageId, name: r.json.name });
        return { ok: true };
      },
    },
    {
      method: "GET",
      path: "/chat/history",
      handler: (r) => {
        const channel = r.query.get("channel");
        const thread = r.query.get("thread");
        const all = [
          ...messages.map((m) => ({
            id: m.id,
            channel: m.channel,
            ...(m.thread ? { thread: m.thread } : {}),
            author: { id: m.authorId, name: m.authorName, trusted: true, bot: false },
            text: m.text,
            at: m.at,
          })),
          ...posts.map((p) => ({
            id: p.id,
            channel: p.channel,
            ...(p.thread ? { thread: p.thread } : {}),
            author: { id: "U0SAM00001", name: "Sam", trusted: false, bot: true },
            text: p.text,
            at: p.at,
          })),
        ]
          .filter((m) => m.channel === channel)
          .filter((m) => (thread ? m.thread === thread || m.id === thread : !m.thread))
          .toSorted((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

        return { messages: all.slice(-Number(r.query.get("limit") ?? 10)) };
      },
    },
    {
      method: "POST",
      path: "/_test/chat/say",
      handler: (r) => {
        const message: Message = {
          seq: messages.length + 1,
          id: id(),
          channel: DIRECT,
          ...(r.json.thread ? { thread: r.json.thread } : {}),
          authorId: HUMAN.id,
          authorName: HUMAN.name,
          text: r.json.text,
          at: new Date().toISOString(),
        };

        messages.push(message);
        return { id: message.id };
      },
    },
    // The scripted runtime asks; a closed gate holds it, and the driver sees that it arrived.
    {
      method: "GET",
      path: "/gates/:name",
      handler: (r) => {
        const g = gate(r.params["name"]!);
        if (!g.open) {
          g.arrived = true;
        }

        return { open: g.open };
      },
    },
    {
      method: "POST",
      path: "/_test/gates/:name/close",
      handler: (r) => {
        Object.assign(gate(r.params["name"]!), { open: false, arrived: false });
        return { ok: true };
      },
    },
    {
      method: "POST",
      path: "/_test/gates/:name/open",
      handler: (r) => {
        gate(r.params["name"]!).open = true;
        return { ok: true };
      },
    },
  ];

  return {
    routes,
    state: () => ({
      posts,
      reactions,
      messages,
      gates: Object.fromEntries(gates),
    }),
  };
}
