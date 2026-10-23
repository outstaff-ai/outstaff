#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { githubVcs } from "@outstaff/vcs-github";
import { itsaplanTracker } from "@outstaff/tracker-itsaplan";
import { slackChat } from "@outstaff/chat-slack";
import {
  AdapterRegistry,
  envSecretSource,
  formatIssue,
  loadCatalog,
  loadTeamConfig,
  type Logger,
  type SecretSource,
} from "@outstaff/core";
import { systemClock } from "./clock.js";
import { createHealthServer, type HealthServer } from "./health.js";
import { createOffice, type CreateOfficeInput, type Office } from "./office.js";
import { openStore } from "./store/index.js";

export const DEFAULT_STORE_URL = "sqlite:///var/lib/outstaff/office.db";

type Env = Record<string, string | undefined>;

/** One JSON object per line, which every log collector reads. */
export function jsonLogger(
  write: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
): Logger {
  const at = (level: string) => (message: string, fields?: Record<string, unknown>) =>
    write(JSON.stringify({ time: new Date().toISOString(), level, message, ...fields }));

  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

export function officeRegistry(): AdapterRegistry {
  return new AdapterRegistry().register(githubVcs).register(itsaplanTracker).register(slackChat);
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

export interface RunningOffice {
  office: Office;
  health: HealthServer;
  stop(): Promise<void>;
}

export interface StartDeps {
  registry?: AdapterRegistry;
  secrets?: SecretSource;
  logger?: Logger;
  stockCatalogDir?: string;
}

/**
 * Environment in, running office out.
 *
 * - `OUTSTAFF_TEAM_FILE` / `OUTSTAFF_TEAM_REPO` (+ `OUTSTAFF_TEAM_REF`): where team.yaml is (see the team loader)
 * - `OUTSTAFF_STORE_URL`: `postgres://…`, `sqlite:///path` or `sqlite::memory:`
 * - `OUTSTAFF_AGENT_PORT` (8080), `OUTSTAFF_WEBHOOK_PORT` (8082), `OUTSTAFF_HEALTH_PORT` (8081)
 */
export async function startOffice(
  env: Env = process.env,
  deps: StartDeps = {},
): Promise<RunningOffice> {
  const log = deps.logger ?? jsonLogger();
  const loaded = await loadTeamConfig({ env });
  if (!loaded.ok) {
    throw new Error(`team.yaml is not valid:\n${loaded.issues.map(formatIssue).join("\n")}`);
  }

  const url = env["OUTSTAFF_STORE_URL"] || DEFAULT_STORE_URL;
  if (url.startsWith("sqlite://") && url !== "sqlite::memory:") {
    await mkdir(dirname(url.slice("sqlite://".length)), { recursive: true });
  }

  const store = await openStore(url);
  let office: Office;
  try {
    office = await createOffice({
      team: loaded.config,
      registry: deps.registry ?? officeRegistry(),
      secrets: deps.secrets ?? envSecretSource(env),
      store,
      clock: systemClock,
      logger: log,
      catalog: loadRoles(loaded.config, loaded.source.dir, log, deps.stockCatalogDir),
      options: {
        agentPort: port(env, "OUTSTAFF_AGENT_PORT", 8080),
        webhookPort: port(env, "OUTSTAFF_WEBHOOK_PORT", 8082),
      },
    });
  } catch (error) {
    await store.close();
    throw error;
  }

  const health = createHealthServer(office, port(env, "OUTSTAFF_HEALTH_PORT", 8081));
  // Liveness answers while the office starts, so a slow first rescan is not mistaken for a hang.
  await health.start();
  try {
    await office.start();
  } catch (error) {
    await health.stop();
    throw error;
  }

  return {
    office,
    health,
    async stop() {
      await office.stop();
      await health.stop();
    },
  };
}

async function main() {
  const log = jsonLogger();
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
