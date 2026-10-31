import type { Route } from "@outstaff/testing.http";

/**
 * A chat workspace for the end-to-end test: each agent's chat adapter polls it for the messages written to that agent
 * (e2e/runtime-scripted/src/chat.ts), and the driver speaks in it as a trusted human of the acme team, to sam unless
 * it names another agent. Each agent has its own direct message with the human. Gates hold a scripted round until
 * the driver opens them, so the test can talk to the agent while a round is still running.
 */

interface Message {
  seq: number;
  id: string;

  /** The agent the message is written to. */
  to: string;
  channel: string;
  thread?: string;
  authorId: string;
  authorName: string;
  text: string;
  at: string;
  files?: { id: string; name: string; mimetype: string; size: number; url: string }[];
}

export const HUMAN = { id: "U0ADA00001", name: "Ada Admin" };

/** The direct message of the human with an agent. */
export const directWith = (agent: string) => `D-${agent}-${HUMAN.id}`;

/** An agent's bot user, as the chat history shows it. */
const botOf = (agent: string) => ({
  id: `U0${agent.toUpperCase()}00001`,
  name: agent.charAt(0).toUpperCase() + agent.slice(1),
});

export function createChat() {
  const messages: Message[] = [];
  const posts: {
    id: string;
    agent: string;
    channel: string;
    thread?: string;
    text: string;
    at: string;
  }[] = [];

  const reactions: { channel: string; messageId: string; name: string }[] = [];
  const profiles: { agent: string; userId: string; profile: Record<string, any>; at: string }[] =
    [];

  const files = new Map<string, { mimetype: string; data: Buffer }>();
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
        messages: messages.filter(
          (m) =>
            m.seq > Number(r.query.get("after") ?? 0) && m.to === (r.query.get("agent") ?? "sam"),
        ),
      }),
    },
    {
      method: "POST",
      path: "/chat/post",
      handler: (r) => {
        const post = {
          id: id(),
          agent: r.json.agent ?? "sam",
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
      method: "POST",
      path: "/chat/profile",
      handler: (r) => {
        profiles.push({
          agent: r.json.agent ?? "sam",
          userId: r.json.userId,
          profile: r.json.profile,
          at: new Date().toISOString(),
        });

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
            ...(m.files ? { files: m.files } : {}),
          })),
          ...posts.map((p) => ({
            id: p.id,
            channel: p.channel,
            ...(p.thread ? { thread: p.thread } : {}),
            author: { ...botOf(p.agent), trusted: false, bot: true },
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
        const to = r.json.to ?? "sam";
        const message: Message = {
          seq: messages.length + 1,
          id: id(),
          to,
          channel: directWith(to),
          ...(r.json.thread ? { thread: r.json.thread } : {}),
          authorId: HUMAN.id,
          authorName: HUMAN.name,
          text: r.json.text,
          at: new Date().toISOString(),
        };

        // Files come as base64; the agent downloads them from the stub by the url the message carries.
        const shared = (r.json.files ?? []) as { name: string; mimetype: string; base64: string }[];
        if (shared.length) {
          message.files = shared.map((f) => {
            const fileId = `F${files.size + 1}`;
            const data = Buffer.from(f.base64, "base64");
            files.set(fileId, { mimetype: f.mimetype, data });
            return {
              id: fileId,
              name: f.name,
              mimetype: f.mimetype,
              size: data.length,
              url: `/chat/files/${fileId}`,
            };
          });
        }

        messages.push(message);
        return { id: message.id };
      },
    },
    {
      method: "GET",
      path: "/chat/files/:id",
      handler: (r) => {
        const f = files.get(r.params["id"]!);
        return f
          ? { buffer: f.data, headers: { "content-type": f.mimetype } }
          : { status: 404, body: { error: "no such file" } };
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
      profiles,
      messages,
      gates: Object.fromEntries(gates),
    }),
  };
}
