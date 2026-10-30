import { parseTeamConfig, type TeamConfig } from "@outstaff/core";
import { createFakeChat } from "@outstaff/core/fakes";
import { manualClock } from "#/clock.js";
import { ProtocolError } from "#/protocol/errors.js";
import type { Offer, WorkSource } from "#/protocol/source.types.js";
import { createScheduler } from "#/scheduler/scheduler.js";
import { openStore } from "#/store/index.js";
import type { Store, WorkItem } from "#/store/types.js";
import { createMessaging } from "#/messaging/messaging.js";
import type { MessagingOptions } from "#/messaging/types.js";
import { readRoster } from "#/messaging/roster.js";

const person = (handle: string, role: string) => ({
  handle,
  name: handle.toUpperCase(),
  role,
  model: "sonnet",
});

export function teamConfig(office?: Record<string, unknown>): TeamConfig {
  const result = parseTeamConfig({
    version: 1,
    team: { name: "acme" },
    catalog: { version: "1.0.0" },
    humans: [{ name: "Ada Admin", identities: { chat: "U-ada" } }],
    repos: [{ name: "app", url: "git.acme.example/acme/app", kind: "primary" }],
    people: [
      person("sam", "developer"),
      person("kit", "developer"),
      person("noor", "reviewer"),
      person("mira", "architect"),
      person("lena", "architect"),
    ],
    integrations: {
      chat: { adapter: "fake" },
      vcs: { adapter: "fake" },
      runtime: { adapter: "fake" },
      tracker: { adapter: "fake" },
    },
    ...(office ? { office } : {}),
  });

  if (!result.ok) {
    throw new Error(JSON.stringify(result.issues));
  }

  return result.config;
}

/** A work source over the real store and scheduler, as the composition root will build it. */
export function storeSource(
  store: Store,
  scheduler: ReturnType<typeof createScheduler>,
  team: TeamConfig,
): WorkSource {
  const offerOf = async (item: WorkItem): Promise<Offer> => ({
    workItem: {
      id: item.id,
      kind: item.kind,
      title: item.title,
      priority: item.priority,
      trigger: item.trigger,
      ...(item.parentId ? { parentId: item.parentId } : {}),
    },
    ...(item.sessionId ? { sessionId: item.sessionId } : {}),
    context: {
      journal: (await store.readJournal(item.id)).map((j) => ({
        at: j.at,
        author: j.author,
        text: j.text,
      })),
      subjects: item.subject ? [{ type: item.subject.type, ref: item.subject.ref }] : [],
      links: [],
    },
  });

  const own = async (person: string, id: string) => {
    const item = await store.getItem(id);
    if (!item || item.person !== person) {
      throw new ProtocolError("unknown_item", `No work item ${id} for ${person}.`);
    }

    return item;
  };

  return {
    async outstanding(person) {
      const active = await store.listItems({ person, status: "active" });
      return Promise.all(active.map(async (i) => ({ offer: await offerOf(i), accepted: true })));
    },
    async next(person) {
      const item = await scheduler.next(person);
      if (!item) {
        return undefined;
      }

      const started = await scheduler.markActive(item.id);
      return started.started ? offerOf(started.item) : undefined;
    },
    accept: async () => {},
    status: async () => [],
    async setSession(person, id, sessionId) {
      await own(person, id);
      await store.updateItem(id, { sessionId });
    },
    decline: async () => {},
    heartbeat: async () => {},
    progress: async () => {},
    async journal(person, id, text) {
      await own(person, id);
      await store.appendJournal(id, person, text);
    },
    async handBack(person, id, result) {
      await own(person, id);
      await store.appendJournal(id, person, result.summary);
      await scheduler.finish(id, {
        outcome: result.summary,
        status: result.status === "done" ? "done" : "waiting",
      });
    },
    async fail(person, id, reason) {
      await own(person, id);
      await scheduler.finish(id, { outcome: "failed", error: reason, status: "queued" });
    },
    roster: async () => (await readRoster({ store, team })).members,
    list: async () => [],
    move: async () => {
      throw new ProtocolError("unsupported", "not in this test source");
    },
    place: async () => {
      throw new ProtocolError("unsupported", "not in this test source");
    },
  };
}

export async function harness(
  opts: { office?: Record<string, unknown>; maxRuns?: number } & Partial<MessagingOptions> = {},
) {
  const { office, maxRuns, ...rest } = opts;
  const clock = manualClock();
  const store = await openStore("sqlite::memory:", { now: () => clock.now() });
  const team = teamConfig(office);
  if (maxRuns) {
    team.policies = {
      ...team.policies!,
      agent_loop_guard: { max_runs_per_item_per_hour: maxRuns },
    };
  }

  const scheduler = createScheduler({ store, team, clock });
  const chat = createFakeChat();
  const notified: string[] = [];
  const messaging = createMessaging({
    store,
    scheduler,
    team,
    notify: (p) => notified.push(p),
    ...rest,
  });

  /** A running item of the person, like the one an agent asks from. */
  const startItem = async (person: string, subject?: { type: string; ref: string }) => {
    const item = await scheduler.enqueue({
      person,
      kind: "ticket",
      title: `Work of ${person}`,
      trigger: "human",
      ...(subject ? { subject } : {}),
    });

    const r = await scheduler.markActive(item.id);
    if (!r.started) {
      throw new Error(r.detail);
    }

    return r.item;
  };

  return { clock, store, team, scheduler, chat, messaging, notified, startItem };
}
