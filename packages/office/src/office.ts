import {
  silentLogger,
  type AdapterRegistry,
  type Logger,
  type SecretSource,
  type TeamConfig,
  type WorkflowEvent,
} from "@outstaff/core";
import type { Human } from "@outstaff/protocol";
import type { Clock } from "./clock.js";
import { createEngine, type Engine } from "./engine/index.js";
import { createIntake, type Intake } from "./intake/index.js";
import { createMessaging } from "./messaging/index.js";
import type { RoleInfo } from "./messaging/index.js";
import { createOfficePorts, type OfficePorts } from "./ports.js";
import {
  agentAuthFromSecrets,
  createProtocolServer,
  type ProtocolServer,
} from "./protocol/index.js";
import { recipeFor } from "./recipes.js";
import { createUsageTracker, type UsageTracker } from "./usage/index.js";
import { createScheduler, type Scheduler } from "./scheduler/index.js";
import type { Store, WorkItem } from "./store/types.js";
import { schedulerWorkSource } from "./work-source.js";
import { createWorkState, type PrRecord, type WorkState } from "./workstate/index.js";

export interface OfficeOptions {
  /** Port of the agent connection (`/agent`). Default 8080. 0 picks a free one. */
  agentPort?: number;
  agentHost?: string;

  /** Port of the webhook receiver when `office.events` is "webhook". Default 8082. */
  webhookPort?: number;
  webhookHost?: string;

  /** Heartbeat interval the agents are told, and how often queues are checked for new work. */
  heartbeatMs?: number;
  pollMs?: number;

  /** How often the work state rescans open pull requests. */
  refreshIntervalMs?: number;
  staleAfterMinutes?: number;

  /** Minutes after which a usage report counts as unknown. Default 30. */
  usageStaleAfterMinutes?: number;
  officeVersion?: string;
}

export interface CreateOfficeInput {
  team: TeamConfig;
  registry: AdapterRegistry;
  secrets: SecretSource;
  store: Store;
  clock: Clock;
  logger?: Logger;

  /** The merged catalog (stock plus ejected); only the role titles and summaries are read. */
  catalog?: { roles: Record<string, { title: string; summary: string }> };
  options?: OfficeOptions;
}

export interface ComponentHealth {
  ok: boolean;
  detail?: string;
}

export interface OfficeHealth {
  ok: boolean;
  state: "created" | "starting" | "running" | "stopping" | "stopped";
  components: Record<string, ComponentHealth>;
}

export interface Office {
  /** Starts the agent connection first, then work state and intake, then the scheduler's housekeeping. */
  start(): Promise<void>;

  /** Stops taking in events, lets running handlers finish, closes connections and the store. Idempotent. */
  stop(): Promise<void>;
  health(): Promise<OfficeHealth>;

  /** Port the agents connect to, once started. */
  agentPort(): number;

  /** The parts, for diagnostics and tests. */
  readonly parts: {
    intake: Intake;
    workState: WorkState;
    engine: Engine;
    scheduler: Scheduler;
    usage: UsageTracker;
    server: ProtocolServer;
    ports: OfficePorts;
  };
}

type State = OfficeHealth["state"];

const handedBackText = (item: WorkItem) => `handed back ${item.id}`;

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
    ports: { vcs: ports.vcs, ...(ports.tracker ? { tracker: ports.tracker } : {}) },
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
  };

  const engine = createEngine({
    store,
    workState,
    scheduler,
    team,
    clock,
    logger: log,
    ports: {
      ...(ports.tracker ? { tracker: ports.tracker } : {}),
      ...(ports.chat ? { chat: ports.chat } : {}),
    },
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

  // At-least-once and in order: the state reflects the event before the engine judges it, and both are idempotent.
  intake.onEvent(async (event, meta) => {
    await track(workState.apply(event, meta));
    await track(engine.handle(event, meta));
  });

  workState.onEvent(async (event, meta) => {
    await track(engine.handle(event, meta));
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

  const handedBack = async (item: WorkItem) => {
    if (item.status !== "done" || !item.subject) {
      return;
    }

    let subject: WorkflowEvent["subject"] | undefined;
    if (item.subject.type === "ticket") {
      subject = { ticket: item.subject.ref };
    } else if (item.subject.type === "pr") {
      const pr = (await store.getSubject("pr", item.subject.ref))?.data as PrRecord | undefined;
      subject = pr ? { pr: pr.ref, ...(pr.ticket ? { ticket: pr.ticket } : {}) } : undefined;
    }

    if (!subject) {
      return;
    }

    const runs = await store.listRuns(item.id);
    const event: WorkflowEvent = {
      type: "agent.handed_back",
      subject,
      actor: { kind: "agent", id: item.person },
      data: { workItem: item.id, kind: item.kind },
    };

    await track(
      engine.handle(event, {
        source: "workstate",
        externalId: `handed_back:${item.id}:${runs.at(-1)?.id ?? "0"}`,
        trusted: true,
      }),
    );

    await workState.refreshWorkers().catch((error: unknown) => {
      log.warn("refreshing who worked on what failed", { error: String(error) });
    });

    log.info(handedBackText(item), { person: item.person });
  };

  const source = schedulerWorkSource({
    scheduler,
    store,
    team,
    ports: { ...(ports.tracker ? { tracker: ports.tracker } : {}), vcs: ports.vcs },
    roles,
    notify,
    onHandedBack: (item) => handedBack(item),
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

  server = createProtocolServer({
    source,
    messaging,
    usage,
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
  let state: State = "created";
  let stopping: Promise<void> | undefined;
  const up = { server: false, workState: false, intake: false, scheduler: false };

  const halt = async () => {
    state = "stopping";
    if (up.intake) {
      await intake.stop();
    }

    await Promise.allSettled(inFlight);
    if (up.workState) {
      await workState.stop();
    }

    if (up.scheduler) {
      baseScheduler.stop();
    }

    if (up.server) {
      await protocol.stop();
    }

    Object.assign(up, { server: false, workState: false, intake: false, scheduler: false });
    await store.close();
    state = "stopped";
  };

  const stop = () => (stopping ??= halt());

  return {
    parts: { intake, workState, engine, scheduler, usage, server: protocol, ports },

    async start() {
      if (state !== "created") {
        throw new Error(`The office cannot start from state ${state}.`);
      }

      state = "starting";
      try {
        await protocol.start();
        up.server = true;
        await workState.start();
        up.workState = true;
        await workState.rescan().catch((error: unknown) => {
          log.warn("first rescan failed; the next one retries", { error: String(error) });
        });

        await intake.start();
        up.intake = true;
        baseScheduler.start((result) => {
          for (const item of result.retried) {
            notify(item.person);
          }

          for (const b of result.blocked) {
            log.warn("work item blocked", { item: b.item.id, code: b.code, reason: b.reason });
          }
        });

        up.scheduler = true;
        state = "running";
        log.info("office started", { team: team.team.name, agentPort: protocol.port() });
      } catch (error) {
        await stop();
        throw error;
      }
    },

    stop,

    async health() {
      const components: Record<string, ComponentHealth> = {
        protocol: {
          ok: up.server,
          ...(up.server ? { detail: `${protocol.connected().length} connected` } : {}),
        },
        workState: { ok: up.workState },
        intake: { ok: up.intake },
        scheduler: { ok: up.scheduler },
      };

      try {
        await store.listPauses();
        components["store"] = { ok: state !== "stopped", detail: store.dialect };
      } catch (error) {
        components["store"] = { ok: false, detail: String(error) };
      }

      return {
        ok: state === "running" && Object.values(components).every((c) => c.ok),
        state,
        components,
      };
    },

    agentPort: () => protocol.port(),
  };
}
