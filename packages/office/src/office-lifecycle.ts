import type { Logger, TeamConfig } from "@outstaff/core";
import type { Intake } from "./intake/index.js";
import type { OfficeLink } from "./link/index.js";
import { linkHealth } from "./office-link.js";
import type { ComponentHealth, Office, OfficeHealth } from "./office.types.js";
import type { ProtocolServer } from "./protocol/index.js";
import type { BlockNotice, Scheduler } from "./scheduler/index.js";
import type { Store } from "./store/types.js";
import type { WorkState } from "./workstate/index.js";

type State = OfficeHealth["state"];

/**
 * Starting, stopping and the health of the office's parts. `scheduler` is the scheduler itself, whose housekeeping
 * runs between start and stop.
 */
export function officeLifecycle(deps: {
  team: Pick<TeamConfig, "team">;
  link: OfficeLink | undefined;
  store: Store;
  log: Logger;
  intake: Intake;
  workState: WorkState;
  scheduler: Scheduler;
  protocol: ProtocolServer;
  inFlight: Set<Promise<unknown>>;
  notify: (person: string) => void;
  onBlocked: (b: BlockNotice) => Promise<void>;

  /** After each tick of the scheduler's housekeeping; never throws. */
  onTick?: () => Promise<unknown>;
}): Pick<Office, "start" | "stop" | "health"> {
  const { team, link, store, log, intake, workState, scheduler, protocol } = deps;
  const { inFlight, notify, onBlocked, onTick } = deps;

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
      scheduler.stop();
    }

    if (up.server) {
      await protocol.stop();
    }

    Object.assign(up, { server: false, workState: false, intake: false, scheduler: false });
    await link?.stop();
    await store.close();
    state = "stopped";
  };

  const stop = () => (stopping ??= halt());

  return {
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
        scheduler.start((result) => {
          for (const item of result.retried) {
            notify(item.person);
          }

          for (const item of result.released) {
            notify(item.person);
          }

          for (const b of result.blocked) {
            log.warn("work item blocked", { item: b.item.id, code: b.code, reason: b.reason });
            void onBlocked(b);
          }

          void onTick?.();
        });

        up.scheduler = true;
        link?.start();
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
        // Visible, never fatal: an office without its link still works, so the probes stay green.
        ...(link ? { link: linkHealth(link) } : {}),
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
  };
}
