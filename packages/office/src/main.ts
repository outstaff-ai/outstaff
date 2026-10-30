#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { githubVcs } from "@outstaff/integration.vcs.github";
import { itsaplanKnowledge } from "@outstaff/integration.knowledge.itsaplan";
import { itsaplanTracker } from "@outstaff/integration.tracker.itsaplan";
import { slackChat } from "@outstaff/integration.chat.slack";
import { loadCustomPolicies } from "@outstaff/policy";
import {
  AdapterRegistry,
  envSecretSource,
  formatIssue,
  loadCatalog,
  loadTeamConfig,
  type Logger,
} from "@outstaff/core";
import { systemClock } from "./clock.js";
import { createHealthServer } from "./health.js";
import { createOffice } from "./office.js";
import type { CreateOfficeInput, Office } from "./office.types.js";
import { openStore } from "./store/index.js";
import type { LogLevel, RunningOffice, StartDeps } from "./types.js";

export const DEFAULT_STORE_URL = "sqlite:///var/lib/outstaff/office.db";

type Env = Record<string, string | undefined>;

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

/** `OUTSTAFF_LOG_LEVEL`: the lowest level written. Defaults to `info`, which hides debug. */
export function logLevel(env: Env): LogLevel {
  const raw = env["OUTSTAFF_LOG_LEVEL"];
  if (raw === undefined || raw === "") {
    return "info";
  }

  const level = LOG_LEVELS.find((l) => l === raw);
  if (!level) {
    throw new Error(`OUTSTAFF_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}, got "${raw}".`);
  }

  return level;
}

/** One JSON object per line, which every log collector reads. Lines below `level` are not written. */
export function jsonLogger(
  write: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
  level: LogLevel = "info",
): Logger {
  const min = LOG_LEVELS.indexOf(level);
  const at = (lvl: LogLevel) => (message: string, fields?: Record<string, unknown>) => {
    if (LOG_LEVELS.indexOf(lvl) >= min) {
      write(JSON.stringify({ time: new Date().toISOString(), level: lvl, message, ...fields }));
    }
  };

  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

export function officeRegistry(): AdapterRegistry {
  return new AdapterRegistry()
    .register(githubVcs)
    .register(itsaplanTracker)
    .register(itsaplanKnowledge)
    .register(slackChat);
}

const port = (env: Env, key: string, fallback: number): number => {
  const raw = env[key];
  if (raw === undefined || raw === "") {
    return fallback;
  }

  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`${key} must be a port number, got "${raw}".`);
  }

  return n;
};

/**
 * `OUTSTAFF_POLL_INTERVAL_MS`: a testing knob that overrides `office.poll_interval_seconds`, below its minimum too,
 * so an end-to-end run does not wait seconds for every event. Unset for a real team.
 */
export function pollInterval(env: Env): { pollIntervalMs?: number } {
  const raw = env["OUTSTAFF_POLL_INTERVAL_MS"];
  if (raw === undefined || raw === "") {
    return {};
  }

  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms < 1) {
    throw new Error(`OUTSTAFF_POLL_INTERVAL_MS must be a positive whole number, got "${raw}".`);
  }

  return { pollIntervalMs: ms };
}

/** Roles of the stock catalog with the team's ejected ones over them. A missing catalog only costs the role titles. */
function loadRoles(
  config: { catalog: { path: string; version: string } },
  teamDir: string,
  log: Logger,
  stockDir: string | undefined,
): NonNullable<CreateOfficeInput["catalog"]> {
  const roles: Record<string, { title: string; summary: string }> = {};
  const add = (dir: string, version?: string) => {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      return;
    }

    for (const role of Object.values(loadCatalog(dir, version ? { version } : {}).roles)) {
      roles[role.name] = { title: role.title, summary: role.summary };
    }
  };

  try {
    add(stockDir ?? dirname(fileURLToPath(import.meta.resolve("@outstaff/catalog/package.json"))));
    add(resolve(teamDir, config.catalog.path), config.catalog.version);
  } catch (error) {
    log.warn("could not read the catalog; roles show their ids", { error: String(error) });
  }

  return { roles };
}

/** Runs `step`; when it fails, `undo` runs before the error goes on. */
async function orUndo<T>(step: () => Promise<T>, undo: () => Promise<void>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    await undo();
    throw error;
  }
}

/** The store `OUTSTAFF_STORE_URL` names, with the directory of a SQLite file created first. */
async function openStoreOf(env: Env) {
  const url = env["OUTSTAFF_STORE_URL"] || DEFAULT_STORE_URL;
  if (url.startsWith("sqlite://") && url !== "sqlite::memory:") {
    await mkdir(dirname(url.slice("sqlite://".length)), { recursive: true });
  }

  return openStore(url);
}

/** The test-only poll interval from the environment, said out loud when it is set. */
function pollingOf(env: Env, log: Logger): ReturnType<typeof pollInterval> {
  const polling = pollInterval(env);
  if (polling.pollIntervalMs !== undefined) {
    log.warn(
      "OUTSTAFF_POLL_INTERVAL_MS overrides office.poll_interval_seconds; it is meant for tests",
      { pollIntervalMs: polling.pollIntervalMs },
    );
  }

  return polling;
}

/** The team config and its custom policies; the office does not start with either broken (`ost validate` names the same). */
async function loadTeam(env: Env) {
  const loaded = await loadTeamConfig({ env });
  if (!loaded.ok) {
    throw new Error(`team.yaml is not valid:\n${loaded.issues.map(formatIssue).join("\n")}`);
  }

  const custom = await loadCustomPolicies(loaded.config.policies?.custom ?? [], loaded.source.dir);
  if (custom.issues.length > 0) {
    const lines = custom.issues.map((i) => `policies.custom[${i.index}]: ${i.message}`);
    throw new Error(`a custom policy cannot be loaded:\n${lines.join("\n")}`);
  }

  return { loaded, custom };
}

/**
 * Environment in, running office out.
 *
 * - `OUTSTAFF_TEAM_FILE` / `OUTSTAFF_TEAM_REPO` (+ `OUTSTAFF_TEAM_REF`): where team.yaml is (see the team loader)
 * - `OUTSTAFF_STORE_URL`: `postgres://…`, `sqlite:///path` or `sqlite::memory:`
 * - `OUTSTAFF_AGENT_PORT` (8080), `OUTSTAFF_WEBHOOK_PORT` (8082), `OUTSTAFF_HEALTH_PORT` (8081)
 * - `OUTSTAFF_LOG_LEVEL`: `debug`, `info` (default), `warn` or `error`
 * - `OUTSTAFF_POLL_INTERVAL_MS`: for tests, overrides `office.poll_interval_seconds`
 */
export async function startOffice(
  env: Env = process.env,
  deps: StartDeps = {},
): Promise<RunningOffice> {
  const log = deps.logger ?? jsonLogger(undefined, logLevel(env));
  const polling = pollingOf(env, log);
  const { loaded, custom } = await loadTeam(env);

  const store = await openStoreOf(env);
  const office: Office = await orUndo(
    () =>
      createOffice({
        team: loaded.config,
        registry: deps.registry ?? officeRegistry(),
        secrets: deps.secrets ?? envSecretSource(env),
        store,
        clock: systemClock,
        logger: log,
        catalog: loadRoles(loaded.config, loaded.source.dir, log, deps.stockCatalogDir),
        policies: custom.policies,
        options: {
          agentPort: port(env, "OUTSTAFF_AGENT_PORT", 8080),
          webhookPort: port(env, "OUTSTAFF_WEBHOOK_PORT", 8082),
          ...polling,
          ...(env["OUTSTAFF_SECRETS_DIR"] ? { secretsDir: env["OUTSTAFF_SECRETS_DIR"] } : {}),
        },
      }),
    () => store.close(),
  );

  const health = createHealthServer(office, port(env, "OUTSTAFF_HEALTH_PORT", 8081));
  // Liveness answers while the office starts, so a slow first rescan is not mistaken for a hang.
  await health.start();
  await orUndo(
    () => office.start(),
    () => health.stop(),
  );

  return {
    office,
    health,
    async stop() {
      await office.stop();
      await health.stop();
    },
  };
}

function packageVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };

  return manifest.version;
}

async function main() {
  if (process.argv.slice(2).some((a) => a === "--version" || a === "-v")) {
    process.stdout.write(`${packageVersion()}\n`);
    return;
  }

  let log: Logger;
  try {
    log = jsonLogger(undefined, logLevel(process.env));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  let running: RunningOffice;
  try {
    running = await startOffice(process.env, { logger: log });
  } catch (error) {
    log.error("the office could not start", {
      error: error instanceof Error ? error.message : String(error),
    });

    process.exit(1);
  }

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) {
      return;
    }

    stopping = true;
    log.info("stopping the office", { signal });
    running.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        log.error("the office did not stop cleanly", { error: String(error) });
        process.exit(1);
      },
    );
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// The bin is a symlink (npm, the images), so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  void main();
}
