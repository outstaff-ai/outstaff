import { configuredAdapters, scopeChecks, type DoctorCheck } from "@outstaff/core";
import type { Cancel } from "#/types.js";
import { presentHealth, uniqueNames } from "./present.js";
import { nextDailyRun } from "./schedule.js";
import type { OfficeDoctor, OfficeDoctorOptions } from "./types.js";

const DEFAULT_DAILY_AT = "06:00";
const DEFAULT_RUN_TIMEOUT_MS = 60_000;

/**
 * Runs the doctor checks the office can make itself (its secrets, which include each person's agent token, each
 * configured adapter's live checks and the `extraChecks` of its own ports) at start, daily and on demand, and keeps the ones agents report. Results are
 * stored and logged; nothing is posted.
 */
export function createOfficeDoctor(opts: OfficeDoctorOptions): OfficeDoctor {
  const { team, store, clock, logger: log } = opts;
  const dailyAt = team.office?.doctor?.daily_at ?? DEFAULT_DAILY_AT;
  let running: Promise<void> | undefined;
  let cancel: Cancel | undefined;
  let stopped = false;
  let last: string | undefined;

  /** The configured adapters; the ports `office.doctor.skip` names keep their secrets checked but lose their live checks. */
  const officeAdapters = () => {
    const skip = new Set<string>(team.office?.doctor?.skip ?? []);
    const { found, unknown } = configuredAdapters(team, opts.registry, "office");
    const live = (f: (typeof found)[number]) => {
      const { doctor: _live, ...def } = f.def;
      return skip.has(def.port) ? { ...f, def } : f;
    };

    return { found: found.map(live), unknown };
  };

  const record = async (scope: string, checks: DoctorCheck[]) => {
    await store.recordDoctorRun(scope, uniqueNames(checks));
    const bad = checks.filter((c) => c.status !== "ok");
    for (const c of bad) {
      log.warn(`doctor: ${c.name}`, { scope, status: c.status, detail: c.detail, fix: c.fix });
    }

    log.info("doctor: checks recorded", {
      scope,
      ok: checks.length - bad.length,
      warn: bad.filter((c) => c.status === "warn").length,
      fail: bad.filter((c) => c.status === "fail").length,
    });
  };

  /** The providers' calls have no deadline of their own; one here keeps a stuck provider from holding up a stop. */
  const deadline = (ms: number) => {
    let cancelTimer: Cancel | undefined;
    const expired = new Promise<never>((_, reject) => {
      cancelTimer = clock.setTimeout(() => reject(new Error(`no result within ${ms} ms`)), ms);
    });

    return { expired, cancel: () => cancelTimer?.() };
  };

  const officeChecks = async () =>
    scopeChecks({
      team,
      scope: "office",
      adapters: officeAdapters(),
      secrets: opts.secrets,
      dir: opts.secretsDir,
      // The platform mounts the office's secrets and sets their mode; the CLI checks the files people write.
      fileModes: false,
      handle: "office",
      context: { fetch: opts.fetch ?? fetch, now: () => clock.now() },
      extra: (await opts.extraChecks?.()) ?? [],
    });

  const once = async () => {
    const limit = deadline(opts.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
    try {
      const checks = await Promise.race([officeChecks(), limit.expired]);

      await record("office", checks);
      last = clock.now().toISOString();
    } catch (error) {
      log.warn("doctor: the office's checks could not run", { error: String(error) });
    } finally {
      limit.cancel();
    }
  };

  const run = () => {
    running ??= once().finally(() => (running = undefined));
    return running;
  };

  const schedule = () => {
    const now = clock.now();
    cancel = clock.setTimeout(
      () => {
        void run();
        if (!stopped) {
          schedule();
        }
      },
      nextDailyRun(now, dailyAt).getTime() - now.getTime(),
    );
  };

  const health = async () => presentHealth(await store.listDoctorChecks(), last, clock.now());

  return {
    start() {
      void run();
      schedule();
    },

    async stop() {
      stopped = true;
      cancel?.();
      await running;
    },

    run,

    async report(person, checks) {
      await record(person, checks);
    },

    health,

    lastRun: () => last,

    async component() {
      try {
        const { summary } = await health();
        return { ok: true, detail: `${summary.ok} ok, ${summary.warn} warn, ${summary.fail} fail` };
      } catch (error) {
        return { ok: true, detail: `unknown: ${String(error)}` };
      }
    },
  };
}
