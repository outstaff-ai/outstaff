import { silentLogger, type WorkflowEvent } from "@outstaff/core";
import type { Human } from "@outstaff/protocol";
import { createChatDesk } from "./chat/index.js";
import { createEngine, type EngineMeta } from "./engine/index.js";
import { createIntake } from "./intake/index.js";
import { createMessaging, type RoleInfo } from "./messaging/index.js";
import { officeDocLinks } from "./office-doc-links.js";
import { createHandedBack } from "./office-handback.js";
import { officeLifecycle } from "./office-lifecycle.js";
import { requesterChat } from "./office-requester.js";
import { officeTicketPrs } from "./office-ticket-prs.js";
import type { CreateOfficeInput, Office } from "./office.types.js";
import { createOfficePorts } from "./ports.js";
import { createOfficePipeline } from "./pipeline/office-pipeline.js";
import { createLinkForOffice } from "./office-link.js";
import {
  agentAuthFromSecrets,
  createProtocolServer,
  type ProtocolServer,
} from "./protocol/index.js";
import { recipeFor } from "./recipes.js";
import { createUsageTracker } from "./usage/index.js";
import { createScheduler, type Scheduler } from "./scheduler/index.js";
import type { WorkItem } from "./store/types.js";
import { itemRefs } from "./item-refs.js";
import { schedulerWorkSource } from "./work-source.js";
import { createWorkState } from "./workstate/index.js";

export async function createOffice(input: CreateOfficeInput): Promise<Office> {
  const { team, store, clock } = input;
  const log = input.logger ?? silentLogger;
  const o = input.options ?? {};
  const ports = await createOfficePorts({
    team,
    registry: input.registry,
    secrets: input.secrets,
    clock,
    logger: log,
  });

  const workState = await createWorkState({
    store,
    ports: { vcs: ports.vcs, ...(ports.tracker ? { tracker: ports.tracker } : {}) },
    team,
    clock,
    logger: log,
    ...(o.refreshIntervalMs === undefined ? {} : { refreshIntervalMs: o.refreshIntervalMs }),
  });

  const webhook = team.office?.events === "webhook";
  const intake = createIntake({
    store,
    ports: {
      vcs: ports.vcs,
      ...(ports.tracker ? { tracker: ports.tracker } : {}),
      ...(ports.knowledge ? { knowledge: ports.knowledge } : {}),
    },
    docs: {
      open: (limit) =>
        workState
          .openDocs(limit)
          .map((d) => ({ id: d.id, ...(d.ticket ? { ticket: d.ticket } : {}) })),
    },
    team,
    clock,
    logger: log,
    ...(webhook
      ? {
          webhook: {
            port: o.webhookPort ?? 8082,
            ...(o.webhookHost === undefined ? {} : { host: o.webhookHost }),
          },
        }
      : {}),
  });

  // Agents report their runtime's usage windows over the protocol; the scheduler reads them back from here.
  const usage = createUsageTracker({
    store,
    team,
    clock,
    logger: log,
    ...(o.usageStaleAfterMinutes === undefined
      ? {}
      : { staleAfterMinutes: o.usageStaleAfterMinutes }),
  });

  const baseScheduler = createScheduler({
    store,
    team,
    clock,
    logger: log,
    usage,
    ...(o.staleAfterMinutes === undefined ? {} : { staleAfterMinutes: o.staleAfterMinutes }),
  });

  // The protocol server is created last but must be told about new work, so the callback looks it up late.
  let server: ProtocolServer | undefined;
  const notify = (person: string) => server?.notify(person);

  // Every queued item reaches the scheduler through here: it gets its recipe (if any) and the agent hears of it.
  const scheduler: Scheduler = {
    ...baseScheduler,
    async enqueue(item) {
      const created = await baseScheduler.enqueue(item);
      const recipe = await recipeFor(created, store, workState);
      if (recipe) {
        await store.appendJournal(created.id, "office", recipe);
      }

      notify(created.person);
      return created;
    },
    async retry(itemId, request) {
      const item = await baseScheduler.retry(itemId, request);
      if (item) {
        notify(item.person);
      }

      return item;
    },
  };

  const engine = createEngine({
    store,
    workState,
    scheduler,
    team,
    clock,
    logger: log,
    ports: ports.tracker ? { tracker: ports.tracker } : {},
  });

  const inFlight = new Set<Promise<unknown>>();
  const track = <T>(p: Promise<T>): Promise<T> => {
    inFlight.add(p);
    void p.then(
      () => inFlight.delete(p),
      () => inFlight.delete(p),
    );

    return p;
  };

  // Proposed (decision 0016): the event pipeline beside the engine, off unless `office.pipeline` turns it on. In shadow
  // mode it judges each event before the engine applies anything, so both judge the same state: after the engine it
  // would see the engine's own moves already made, decide "nothing to change", and its traces could not be compared
  // with the engine's. It never throws, so it cannot hold up or fail the engine. Live, it judges instead of the engine.
  const pipelineOptions = { team, store, workState, scheduler, ports, clock, logger: log };
  const officePipeline = createOfficePipeline(pipelineOptions);

  const pipeline = officePipeline.runner;
  const judge = (event: WorkflowEvent, meta: EngineMeta) =>
    track(officePipeline.route(event, meta, () => track(engine.handle(event, meta))));

  // At-least-once and in order: the state reflects the event before the engine judges it, and both are idempotent.
  intake.onEvent(async (event, meta) => {
    await track(workState.apply(event, meta));
    await judge(event, meta);
  });

  workState.onEvent(async (event, meta) => {
    await judge(event, meta);
  });

  const roles = new Map<string, RoleInfo>();
  for (const [key, role] of Object.entries(input.catalog?.roles ?? {})) {
    roles.set(key, { title: role.title, summary: role.summary });
  }

  // Without a humans: list the trusted ones are repo writers and chat members, which the ports cannot list;
  // the tracker's human members are the trusted ones intake already accepts.
  const humans = async (): Promise<Human[]> => {
    try {
      return (
        (await ports.tracker?.members())
          ?.filter((m) => m.kind === "human")
          .map((m) => ({ name: m.name })) ?? []
      );
    } catch (error) {
      log.warn("could not list humans", { error: String(error) });
      return [];
    }
  };

  const handedBack = createHandedBack({ store, workState, judge, log });

  // An item the scheduler blocked: the PM's `unblock` round when the team routes blocked work there, and the report
  // the blocked agent owes the requester (queued, so the agent posts it as itself). The office posts nothing.
  const onBlocked = async (b: { item: WorkItem; reason: string }) => {
    try {
      const routed = await engine.unblock(b.item, b.reason);
      await chatDesk.blocked(b.item, b.reason, routed);
    } catch (error) {
      log.warn("could not route a blocked item", { item: b.item.id, error: String(error) });
    }
  };

  const source = schedulerWorkSource({
    scheduler,
    store,
    team,
    ports: { ...(ports.tracker ? { tracker: ports.tracker } : {}), vcs: ports.vcs },
    roles,
    notify,
    onBlocked,
    onStarted: (item) => engine.started(item.id),
    onHandedBack: async (item, result) => {
      // An interrupted item is still the same round: nothing is reported, no rule runs, no follow-up starts.
      if (result.status === "interrupted") {
        return;
      }

      await chatDesk.handedBack(item, result);
      await handedBack(item);
      await track(engine.settled(item));
      await track(engine.followUp(item.id));
    },
  });

  const messaging = createMessaging({
    store,
    scheduler,
    team,
    logger: log,
    roles,
    humans,
    usage: (person) => usage.summary(person),
    notify,
    ...(ports.chat ? { chat: ports.chat } : {}),
    ...(ports.tracker ? { tracker: ports.tracker } : {}),
  });

  const refs = itemRefs(store, {
    vcs: ports.vcs,
    ...(ports.tracker ? { tracker: ports.tracker } : {}),
  });

  const chatDesk = createChatDesk({
    store,
    scheduler: baseScheduler,
    team,
    workState,
    messaging,
    notify,
    push: (person) => server?.reports(person),
    clock,
    ...(ports.tracker ? { tracker: ports.tracker } : {}),
    // The requester of the item's ticket, else the first human (as the workflow's own fallback does).
    requesterChat: requesterChat({ store, workState, team }),
    linksOf: async (item) =>
      (await refs.subjectsOf(item)).flatMap((r) =>
        r.url && (r.type === "ticket" || r.type === "pr")
          ? [{ url: r.url, title: r.title ? `${r.ref}: ${r.title}` : r.ref }]
          : [],
      ),
  });

  server = createProtocolServer({
    source,
    messaging,
    usage,
    chat: chatDesk,
    docs: officeDocLinks({ store, workState, log }),
    tickets: officeTicketPrs({ workState, log }),
    auth: agentAuthFromSecrets(
      input.secrets,
      team.people.map((p) => p.handle),
    ),
    clock,
    logger: log,
    port: o.agentPort ?? 8080,
    ...(o.agentHost === undefined ? {} : { host: o.agentHost }),
    ...(o.heartbeatMs === undefined ? {} : { heartbeatMs: o.heartbeatMs }),
    ...(o.pollMs === undefined ? {} : { pollMs: o.pollMs }),
    ...(o.officeVersion === undefined ? {} : { officeVersion: o.officeVersion }),
  });

  const protocol = server;
  const link = createLinkForOffice({ input, ports, protocol, log });
  const lifecycle = officeLifecycle({
    link,
    team,
    store,
    log,
    intake,
    workState,
    scheduler: baseScheduler,
    protocol,
    inFlight,
    notify,
    onBlocked,
  });

  return {
    parts: { intake, workState, engine, scheduler, usage, server: protocol, ports, pipeline, link },
    ...lifecycle,
    agentPort: () => protocol.port(),
  };
}
