import { silentLogger, type WorkflowEvent } from "@outstaff/core";
import { createChatDesk } from "./chat/index.js";
import { createIntake } from "./intake/index.js";
import { createMessaging, type RoleInfo } from "./messaging/index.js";
import { createChatEntry } from "./office-chat.js";
import { officeDocLinks } from "./office-doc-links.js";
import { doctorForOffice } from "./office-doctor.js";
import { createHandedBack } from "./office-handback.js";
import { trackerHumans } from "./office-humans.js";
import { createIdlePull } from "./office-idle.js";
import { createOfficeRounds } from "./office-rounds.js";
import { officeLifecycle } from "./office-lifecycle.js";
import { requesterChat } from "./office-requester.js";
import { officeTicketPrs } from "./office-ticket-prs.js";
import type { CreateOfficeInput, Office, OfficeOptions } from "./office.types.js";
import { createOfficePorts } from "./ports.js";
import { createOfficePipeline } from "./pipeline/office-pipeline.js";
import { createLinkForOffice } from "./office-link.js";
import {
  agentAuthFromSecrets,
  createProtocolServer,
  type ProtocolServer,
} from "./protocol/index.js";
import { createUsageTracker } from "./usage/index.js";
import { createScheduler } from "./scheduler/index.js";
import type { WorkItem } from "./store/types.js";
import { defined } from "./defined.js";
import { inFlightTracker } from "./in-flight.js";
import { itemRefs } from "./item-refs.js";
import { notifyingScheduler } from "./office-scheduler.js";
import { schedulerWorkSource } from "./work-source.js";
import { createWorkState } from "./workstate/index.js";

function webhookOptions(o: OfficeOptions) {
  return { webhook: { port: o.webhookPort ?? 8082, ...defined({ host: o.webhookHost }) } };
}

function roleInfo(catalog: CreateOfficeInput["catalog"]): Map<string, RoleInfo> {
  const roles = new Map<string, RoleInfo>();
  for (const [key, role] of Object.entries(catalog?.roles ?? {})) {
    roles.set(key, { title: role.title, summary: role.summary });
  }

  return roles;
}

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

  const tracker = defined({ tracker: ports.tracker });
  const workState = await createWorkState({
    store,
    ports: { vcs: ports.vcs, ...tracker },
    team,
    clock,
    logger: log,
    ...defined({ refreshIntervalMs: o.refreshIntervalMs }),
  });

  const webhook = team.office?.events === "webhook";
  const intake = createIntake({
    store,
    ports: { vcs: ports.vcs, ...tracker, ...defined({ knowledge: ports.knowledge }) },
    docs: {
      open: (limit) =>
        workState
          .openDocs(limit)
          .map((d) => ({ id: d.id, ...(d.ticket ? { ticket: d.ticket } : {}) })),
    },
    team,
    clock,
    logger: log,
    ...(webhook ? webhookOptions(o) : {}),
  });

  // Agents report their runtime's usage windows over the protocol; the scheduler reads them back from here.
  const usage = createUsageTracker({
    store,
    team,
    clock,
    logger: log,
    ...defined({ staleAfterMinutes: o.usageStaleAfterMinutes }),
  });

  // The protocol server is created last but must be told about new work, so the callback looks it up late.
  let server: ProtocolServer | undefined;
  const notify = (person: string) => server?.notify(person);

  const baseScheduler = createScheduler({
    store,
    team,
    clock,
    logger: log,
    usage,
    onReleased: notify,
    ...defined({ staleAfterMinutes: o.staleAfterMinutes }),
  });

  const scheduler = notifyingScheduler({ scheduler: baseScheduler, store, workState, notify });

  const { inFlight, track } = inFlightTracker();

  // The event pipeline decides what the office does with every event (decision 0018). An error propagates, so the
  // event is delivered again; its trace, its wakes and its acts are idempotent per event.
  const pipelineOptions = { team, store, workState, scheduler, ports, clock, logger: log };
  const { runner: pipeline, traces } = createOfficePipeline(pipelineOptions);
  const judge = (event: WorkflowEvent, meta: { source: string; externalId: string }) =>
    track(pipeline.handle(event, meta));

  // At-least-once and in order: the state reflects the event before the pipeline judges it. A ticket change that
  // gives an agent a ready ticket is checked for an idle pull once the event is judged. A chat message changes nothing
  // in the work state.
  intake.onEvent(async (event, meta) => {
    if (event.type === "chat.message") {
      await judge(event, meta);
      return;
    }

    await track(workState.apply(event, meta));
    await judge(event, meta);
    await track(idle.afterEvent(event));
  });

  workState.onEvent(async (event, meta) => {
    await judge(event, meta);
  });

  const roles = roleInfo(input.catalog);

  const humans = trackerHumans(ports, log);

  const handedBack = createHandedBack({ store, workState, judge, log });
  const idle = createIdlePull({ ...pipelineOptions, pipeline });
  const rounds = createOfficeRounds({ store, scheduler, workState, team, logger: log });

  // An item the scheduler blocked: the report the blocked agent owes the requester (queued, so the agent posts it as
  // itself). The office posts nothing.
  const onBlocked = async (b: { item: WorkItem; reason: string }) => {
    try {
      await chatDesk.blocked(b.item, b.reason);
    } catch (error) {
      log.warn("could not report a blocked item", { item: b.item.id, error: String(error) });
    }
  };

  const source = schedulerWorkSource({
    scheduler,
    store,
    team,
    ports: { ...tracker, vcs: ports.vcs },
    roles,
    traces,
    logger: log,
    notify,
    onBlocked,
    onHandedBack: async (item, result) => {
      // An interrupted item is still the same round: nothing is reported or judged, no follow-up starts.
      if (result.status === "interrupted") {
        return;
      }

      await chatDesk.handedBack(item, result);
      await handedBack(item);
      await track(rounds.settle(item));
      await track(rounds.followUp(item.id));
      await track(idle.check(item.person));
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
    ...defined({ chat: ports.chat }),
    ...tracker,
  });

  const refs = itemRefs(store, { vcs: ports.vcs, ...tracker });

  const chatDesk = createChatDesk({
    store,
    scheduler: baseScheduler,
    team,
    workState,
    notify,
    push: (person) => server?.reports(person),
    clock,
    ...tracker,
    // The requester of the item's ticket, else the first human (as the pipeline's own fallback does).
    requesterChat: requesterChat({ store, workState, team }),
    linksOf: async (item) =>
      (await refs.subjectsOf(item)).flatMap((r) =>
        r.url && (r.type === "ticket" || r.type === "pr")
          ? [{ url: r.url, title: r.title ? `${r.ref}: ${r.title}` : r.ref }]
          : [],
      ),
  });

  const chatEntry = createChatEntry({ intake, store, clock });

  const doctor = doctorForOffice(input, ports.vcs, log);
  server = createProtocolServer({
    source,
    team,
    doctor,
    messaging,
    usage,
    chat: { ...chatDesk, message: chatEntry.message },
    docs: officeDocLinks({ store, workState, log }),
    tickets: officeTicketPrs({ workState, log }),
    onConnected: (person) => void track(idle.check(person)),
    auth: agentAuthFromSecrets(
      input.secrets,
      team.people.map((p) => p.handle),
    ),
    clock,
    logger: log,
    port: o.agentPort ?? 8080,
    ...defined({
      host: o.agentHost,
      heartbeatMs: o.heartbeatMs,
      pollMs: o.pollMs,
      officeVersion: o.officeVersion,
    }),
  });

  const protocol = server;
  const link = createLinkForOffice({ input, ports, protocol, doctor, log });
  const lifecycle = officeLifecycle({
    link,
    doctor,
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
    onTick: () => track(idle.sweep()),
  });

  return {
    parts: {
      intake,
      workState,
      scheduler,
      usage,
      server: protocol,
      ports,
      pipeline,
      link,
      doctor,
    },
    ...lifecycle,
    agentPort: () => protocol.port(),
  };
}
