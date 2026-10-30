import { createOfficeConnection, type Offer, type OfficeConnection } from "@outstaff/agent";
import {
  AdapterRegistry,
  envSecretSource,
  parseTeamConfig,
  silentLogger,
  type PortName,
  type RepoRef,
  type TeamConfig,
} from "@outstaff/core";
import {
  createFakeAdapterRegistry,
  createFakeChat,
  createFakeTracker,
  createFakeVcs,
} from "@outstaff/core/fakes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import { readFeedback } from "#/engine/feedback.js";
import { createChatEntry } from "#/office-chat.js";
import { createOffice } from "#/office.js";
import type { Office } from "#/office.types.js";
import type { Trace } from "#/pipeline/trace.types.js";
import { openStore, type Store } from "#/store/index.js";

const REPO: RepoRef = { host: "git.acme.example", owner: "acme", name: "app" };
const KOFI_LOGIN = "acme-kofi[bot]";
const SAM_CHAT = "U-SAM";
const DM = "D-SAM";
type Mode = "off" | "shadow" | "live";

function team(mode: Mode): TeamConfig {
  const result = parseTeamConfig({
    version: 1,
    team: { name: "acme" },
    catalog: { version: "1.0.0" },
    humans: [
      { name: "Sam", identities: { vcs: "sam", tracker: "u-2", chat: SAM_CHAT } },
      { name: "Dana", identities: { vcs: "dana" } },
    ],
    repos: [{ name: "app", url: "git.acme.example/acme/app", kind: "primary" }],
    people: [
      {
        handle: "kofi",
        name: "Kofi",
        role: "developer",
        model: "sonnet",
        identities: { vcs: KOFI_LOGIN, tracker: "u-3" },
      },
    ],
    integrations: {
      chat: { adapter: "fake" },
      vcs: { adapter: "fake" },
      runtime: { adapter: "fake" },
      tracker: { adapter: "fake" },
    },
    office: { pipeline: mode },
  });

  if (!result.ok) {
    throw new Error(JSON.stringify(result.issues));
  }

  return result.config;
}

const dm = (messageId: string, text: string) => ({
  messageId,
  channel: DM,
  text,
  author: { id: SAM_CHAT, name: "Sam" },
  direct: true,
  participant: true,
});

function harness(mode: Mode) {
  const h = {
    clock: manualClock(),
    office: undefined as unknown as Office,
    store: undefined as unknown as Store,
    kofi: undefined as unknown as OfficeConnection,
    vcs: undefined as unknown as ReturnType<typeof createFakeVcs>,
    tracker: undefined as unknown as ReturnType<typeof createFakeTracker>,
  };

  beforeEach(async () => {
    const { clock } = h;
    h.vcs = createFakeVcs({ now: clock.now });
    h.tracker = createFakeTracker({
      now: clock.now,
      actor: { id: "u-1", name: "Office", kind: "agent" },
    });

    const stock = createFakeAdapterRegistry();
    const instances = { vcs: h.vcs, tracker: h.tracker, chat: createFakeChat({ now: clock.now }) };
    const registry = new AdapterRegistry();
    for (const port of ["vcs", "tracker", "chat"] as PortName[]) {
      registry.register({
        ...stock.get(port, "fake")!,
        create: () => (instances as Record<string, unknown>)[port] as never,
      });
    }

    await h.tracker.seed.member({ name: "Sam", kind: "human" });
    await h.tracker.seed.member({ name: "Kofi", kind: "agent" });
    await h.vcs.seed.permission(REPO, "dana", "write");
    h.store = await openStore("sqlite::memory:", { now: () => clock.now() });
    h.office = await createOffice({
      team: team(mode),
      registry,
      secrets: envSecretSource({ OUTSTAFF_AGENT_TOKEN_KOFI: "kofi-token" }, "/nonexistent"),
      store: h.store,
      clock,
      options: { agentPort: 0, agentHost: "127.0.0.1" },
    });

    await h.office.start();
    await h.office.parts.intake.pollOnce();
    h.kofi = createOfficeConnection({
      url: `ws://127.0.0.1:${h.office.agentPort()}/agent`,
      person: "kofi",
      token: "kofi-token",
      agentVersion: "test",
      clock,
    });

    h.kofi.start();
    await h.kofi.whenConnected();
  });

  afterEach(async () => {
    await h.kofi.stop();
    await h.office.stop();
  });

  return h;
}

const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 300 && !(await check()); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** Moves the clock on a second at a time, so the connection's heartbeats keep flowing. */
async function pass(h: { clock: { advance(ms: number): void } }, ms: number) {
  for (let t = 0; t < ms; t += 1_000) {
    h.clock.advance(1_000);
    await new Promise((r) => setTimeout(r, 2));
  }
}

async function next(kofi: OfficeConnection): Promise<Offer> {
  const r = await kofi.offers()[Symbol.asyncIterator]().next();
  if (r.done) {
    throw new Error("no offer");
  }

  await kofi.accept(r.value.workItem.id, { runtime: "claude", model: "sonnet" });
  return r.value;
}

const traces = async (store: Store) =>
  (await store.listTraces({ limit: 100 })).map((t) => t.data as Trace);

describe.each(["off", "shadow", "live"] as const)(
  "Sam DMs Kofi about a ticket (office.pipeline: %s)",
  { timeout: 30_000 },
  (mode) => {
    const h = harness(mode);

    /** Sam asks Kofi about a ticket; returns the ticket, the text and Kofi's offer. */
    async function ask() {
      const issue = await h.tracker.createIssue({ title: "Coupon", body: "", status: "backlog" });
      await h.office.parts.intake.pollOnce();
      const text = `can you look at ${issue.key}?`;
      const result = await h.kofi.chatMessage(dm("1700.1", text));
      expect(result.disposition).toBe(mode === "live" ? "received" : "started");

      // Live, the run is held for the coalescing window, then offered.
      await until(async () => (await h.store.listItems({ person: "kofi" })).length > 0);
      await pass(h, 60_000);
      return { issue, text, offer: await next(h.kofi) };
    }

    it("wakes Kofi once, in a chat session that carries the message and the ticket it names", async () => {
      const { issue, text, offer } = await ask();
      expect(offer.workItem).toMatchObject({
        kind: "chat",
        title: `Chat: ${text}`,
        origin: { channel: DM, thread: "1700.1", requester: { id: SAM_CHAT, name: "Sam" } },
      });

      expect(await h.store.listItems({ person: "kofi" })).toHaveLength(1);
      const carried = [
        ...offer.context.journal.map((j) => j.text),
        ...(offer.context.feedback ?? []).map((f) => f.body),
      ];

      expect(carried.some((t) => t.includes(text))).toBe(true);
      const wake = offer.context.wake!;
      expect(wake.chats[0]).toMatchObject({ channel: DM, thread: "1700.1" });
      expect(wake.tickets.map((t) => [t.key, t.why.role])).toEqual([[issue.key, "mentioned"]]);

      // The same message again is a repeat: nothing more is queued.
      expect((await h.kofi.chatMessage(dm("1700.1", text))).repeated).toBe(true);
      expect(await h.store.listItems({ person: "kofi" })).toHaveLength(1);
    });

    it("traces the message: not when off, beside what the desk did in shadow mode, with its item live", async () => {
      const { offer } = await ask();
      await until(
        async () => mode !== "shadow" || (await traces(h.store)).some((t) => t.comparison),
      );

      const chat = (await traces(h.store))
        .filter((t) => t.event.type === "chat.message")
        .map((t) => ({
          event: [t.event.id, t.event.subject, t.event.actor],
          wakes: t.decisions.map(
            (d) => d.type === "wake" && [d.policy, d.person, d.kind, d.itemId],
          ),
          engine: t.engine,
          comparison: t.comparison,
        }));

      const traced = {
        event: [
          `chat:kofi:${DM}:1700.1`,
          { chat: { channel: DM } },
          { kind: "human", id: SAM_CHAT },
        ],
        wakes: [
          ["chat_to_addressed", "kofi", "chat", mode === "live" ? offer.workItem.id : undefined],
        ],
      };

      // In shadow mode the desk started the session, and the pipeline would wake Kofi on the same conversation.
      const shadow = {
        engine: {
          effects: [
            { type: "wake", person: "kofi", kind: "chat", subject: { type: "chat", ref: DM } },
          ],
        },
        comparison: { agree: true, differences: [] },
      };

      expect(chat).toEqual({ off: [], shadow: [{ ...traced, ...shadow }], live: [traced] }[mode]);
    });
  },
);

describe("wakes coalesce (office.pipeline: live)", { timeout: 30_000 }, () => {
  const h = harness("live");

  it("runs three messages Sam sends Kofi within 20 seconds as one chat session", async () => {
    const texts = ["the checkout is broken", "it drops the coupon", "on reload only"];
    for (const [i, text] of texts.entries()) {
      await h.kofi.chatMessage(dm(`1700.${i + 1}`, text));
      await until(async () => (await traces(h.store)).length === i + 1);
      await pass(h, 10_000);
    }

    const items = await h.store.listItems({ person: "kofi" });
    expect(items).toMatchObject([
      { kind: "chat", status: "queued", notBefore: expect.any(String) },
    ]);

    expect((await readFeedback(h.store, items[0]!.id)).map((f) => f.body)).toEqual(texts);

    // Nothing is offered until the window of the first message closes.
    await pass(h, 30_000);
    const offer = await next(h.kofi);
    expect(offer.workItem.id).toBe(items[0]!.id);
    expect(offer.context.feedback?.map((f) => f.body)).toEqual(texts);

    const last = (await traces(h.store)).find((t) => t.event.id === `chat:kofi:${DM}:1700.3`)!;
    expect(last.decisions).toMatchObject([
      {
        type: "wake",
        itemId: items[0]!.id,
        folded: [1, 2, 3].map((n) => `chat:kofi:${DM}:1700.${n}`),
      },
    ]);
  });

  it("runs four review comments on Kofi's pull request within a minute as one review_feedback round", async () => {
    const pr = await h.vcs.seed.pullRequest(REPO, {
      title: "Keep the coupon",
      head: { ref: "kofi/coupon" },
      author: { login: KOFI_LOGIN, kind: "agent" },
    });

    await h.office.parts.intake.pollOnce();
    const bodies = ["Rename it.", "Add a test.", "Drop the log line.", "Use the helper."];
    for (const body of bodies) {
      await h.vcs.seed.comment(REPO, pr.number, "dana", body);
      await pass(h, 1_000);
      await h.office.parts.intake.pollOnce();
      await pass(h, 10_000);
    }

    await until(
      async () => (await traces(h.store)).filter((t) => t.event.type === "pr.comment").length === 4,
    );

    const items = await h.store.listItems({ person: "kofi" });
    expect(items).toMatchObject([
      { kind: "review_feedback", status: "queued", notBefore: expect.any(String) },
    ]);

    await pass(h, 60_000);
    const offer = await next(h.kofi);
    expect(offer.workItem.id).toBe(items[0]!.id);
    expect(offer.context.feedback?.map((f) => f.body)).toEqual(bodies);

    const comments = (await traces(h.store)).filter((t) => t.event.type === "pr.comment");
    const folded = comments.flatMap((t) => t.decisions).filter((d) => d.type === "wake");
    expect(folded.map((d) => d.itemId)).toEqual(bodies.map(() => items[0]!.id));
    expect(
      folded
        .filter((d) => d.folded)
        .map((d) => d.folded!.length)
        .toSorted(),
    ).toEqual([2, 3, 4]);
  });
});

describe("createChatEntry", () => {
  it("still answers with what the desk did when shadow mode cannot record the message", async () => {
    const warned: string[] = [];
    const answer = {
      disposition: "started" as const,
      repeated: false,
      item: { id: "w-1", title: "t", status: "queued" },
      links: [],
      work: [],
    };

    const entry = createChatEntry({
      mode: "shadow",
      desk: { message: async () => answer },
      intake: { receive: () => Promise.reject(new Error("store down")) },
      store: {} as never,
      clock: manualClock(),
      logger: { ...silentLogger, warn: (m) => void warned.push(m) },
    });

    expect(await entry.message("kofi", dm("1700.1", "hi"))).toBe(answer);
    expect(warned).toEqual(["pipeline (shadow) could not record a chat message"]);
  });
});
