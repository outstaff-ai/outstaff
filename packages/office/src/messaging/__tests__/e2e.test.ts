import {
  createOfficeConnection,
  findVerb,
  runVerb,
  type AgentEnv,
  type OfficeConnection,
} from "@outstaff/agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentAuth } from "#/protocol/auth.js";
import { createProtocolServer } from "#/protocol/server.js";
import type { ProtocolServer } from "#/protocol/types.js";
import { harness, storeSource } from "./test-support.js";
import { createMessaging } from "#/messaging/messaging.js";
import { fakeTeam } from "@outstaff/testing.office";

type Harness = Awaited<ReturnType<typeof harness>>;

describe("agent-to-agent questions through the real server and client", () => {
  let h: Harness;
  let server: ProtocolServer;
  let conns: OfficeConnection[];
  let conn: (person: string) => OfficeConnection;

  beforeEach(async () => {
    h = await harness();
    conns = [];
    const source = storeSource(h.store, h.scheduler, h.team);
    const messaging = createMessaging({
      store: h.store,
      scheduler: h.scheduler,
      team: h.team,
      chat: h.chat,
      channel: "C-team",
      roles: new Map([["architect", { title: "Architect", summary: "Designs the system." }]]),
      notify: (p) => server.notify(p),
    });

    server = createProtocolServer({
      source,
      team: fakeTeam(),
      messaging,
      auth: createAgentAuth({ sam: "sam-token", mira: "mira-token", lena: "lena-token" }),
      clock: h.clock,
      port: 0,
      host: "127.0.0.1",
    });

    await server.start();
    conn = (person) => {
      const c = createOfficeConnection({
        url: `ws://127.0.0.1:${server.port()}/agent`,
        person,
        token: `${person}-token`,
        agentVersion: "test",
        clock: h.clock,
      });

      c.start();
      conns.push(c);
      return c;
    };
  });

  afterEach(async () => {
    await Promise.all(conns.map((c) => c.stop()));
    await server.stop();
    await h.store.close();
  });

  const envOf = (c: OfficeConnection, person: string) =>
    ({
      person,
      team: h.team,
      log: { debug() {}, info() {}, warn() {}, error() {} },
      office: c,
    }) as unknown as AgentEnv;

  const next = async (c: OfficeConnection) => {
    const r = await c.offers()[Symbol.asyncIterator]().next();
    if (r.done) {
      throw new Error("no offer");
    }

    return r.value;
  };

  it("routes ost ask to the architect, who answers, and the asker continues with it", async () => {
    const sam = conn("sam");
    const mira = conn("mira");
    await Promise.all([sam.whenConnected(), mira.whenConnected()]);

    await h.scheduler.enqueue({
      person: "sam",
      kind: "ticket",
      title: "Build the cart",
      trigger: "human",
    });

    server.notify("sam");
    const own = await next(sam);
    await sam.accept(own.workItem.id, { runtime: "claude" });

    const verb = findVerb("ask")!;
    const asked = await runVerb(
      verb,
      envOf(sam, "sam"),
      { to: "architect", question: "Which queue should orders use?" },
      { workItemId: own.workItem.id },
    );

    expect(asked.text).toContain("Asked mira");
    await sam.handBack(own.workItem.id, {
      summary: "Waiting for the architect.",
      status: "waiting",
    });

    const offer = await next(mira);
    expect(offer.workItem).toMatchObject({
      kind: "question",
      trigger: "agent",
      parentId: own.workItem.id,
    });

    const text = offer.context.journal.map((j) => j.text).join("\n");
    expect(text).toContain("Which queue should orders use?");
    const questionId = /ost answer (\S+) "/.exec(text)![1]!;
    await mira.accept(offer.workItem.id, { runtime: "claude" });
    expect(text).toContain("from sam (developer)");
    expect(text).toContain("is working on: Build the cart");
    expect(text).toContain(`ost answer ${questionId}`);
    const answered = await runVerb(
      findVerb("question.answer")!,
      envOf(mira, "mira"),
      { question: questionId, answer: "Use the fast queue." },
      { workItemId: offer.workItem.id },
    );

    expect(answered.text).toContain(`Answered question ${questionId}`);
    await mira.handBack(offer.workItem.id, { summary: "Answered.", status: "done" });

    const resumed = await next(sam);
    expect(resumed.workItem.id).toBe(own.workItem.id);
    expect(resumed.context.journal.map((j) => j.text).join("\n")).toContain("Use the fast queue.");
    expect(h.chat.posts).toHaveLength(2);
  });

  it("answers a missing role to the asker verbatim", async () => {
    const sam = conn("sam");
    await sam.whenConnected();
    await h.scheduler.enqueue({
      person: "sam",
      kind: "ticket",
      title: "Ship it",
      trigger: "human",
    });

    server.notify("sam");
    const own = await next(sam);
    await expect(
      runVerb(
        findVerb("ask")!,
        envOf(sam, "sam"),
        { to: "devops", question: "Deploy?" },
        { workItemId: own.workItem.id },
      ),
    ).rejects.toThrow("no devops on this team; ask a human");
  });

  it("shows the live roster with titles and humans to ost team", async () => {
    const sam = conn("sam");
    await sam.whenConnected();
    const r = await runVerb(findVerb("team")!, envOf(sam, "sam"), {}, {});
    expect(r.text).toContain("mira (MIRA), Architect: idle");
    expect(r.text).toContain("sam (SAM), developer: idle");
    expect(r.text).toContain("Humans: Ada Admin");
  });
});

describe("an answer that arrives while the asker is still running", () => {
  it("is delivered when the asker hands back as waiting", async () => {
    const h = await harness();
    const source = storeSource(h.store, h.scheduler, h.team);
    const messaging = createMessaging({
      store: h.store,
      scheduler: h.scheduler,
      team: h.team,
      notify: (p) => server.notify(p),
    });

    const server = createProtocolServer({
      source,
      team: fakeTeam(),
      messaging,
      auth: createAgentAuth({ sam: "sam-token", mira: "mira-token" }),
      clock: h.clock,
      port: 0,
      host: "127.0.0.1",
    });

    await server.start();
    const mk = (person: string) => {
      const c = createOfficeConnection({
        url: `ws://127.0.0.1:${server.port()}/agent`,
        person,
        token: `${person}-token`,
        agentVersion: "test",
        clock: h.clock,
      });

      c.start();
      return c;
    };

    const sam = mk("sam");
    const mira = mk("mira");
    try {
      await Promise.all([sam.whenConnected(), mira.whenConnected()]);
      const item = await h.scheduler.enqueue({
        person: "sam",
        kind: "ticket",
        title: "Cart",
        trigger: "human",
      });

      server.notify("sam");
      const own = await sam.offers()[Symbol.asyncIterator]().next();
      const id = own.value!.workItem.id;
      expect(id).toBe(item.id);
      await sam.accept(id, { runtime: "claude" });
      const asked = await sam.ask({ to: "mira", question: "Which queue?", workItemId: id });

      const offer = (await mira.offers()[Symbol.asyncIterator]().next()).value!;
      await mira.accept(offer.workItem.id, { runtime: "claude" });
      // The answer comes while sam is still working.
      await mira.answer(asked.id, "The fast one.");
      expect((await h.store.getItem(id))?.status).toBe("active");
      expect((await h.store.listUndelivered(id)).map((c) => c.id)).toEqual([asked.id]);

      await sam.handBack(id, { summary: "Waiting for mira.", status: "waiting" });
      expect(await h.store.listUndelivered(id)).toEqual([]);
      const again = (await sam.offers()[Symbol.asyncIterator]().next()).value!;
      expect(again.workItem.id).toBe(id);
      expect(again.context.journal.map((j: { text: string }) => j.text).join("\n")).toContain(
        "The fast one.",
      );
    } finally {
      await Promise.all([sam.stop(), mira.stop()]);
      await server.stop();
      await h.store.close();
    }
  });
});
