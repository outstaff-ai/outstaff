#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "@outstaff/core";
import { StartupError, agentRegistry, prepareAgent } from "./runner/index.js";

const write = (level: string) => (message: string, data?: Record<string, unknown>) =>
  process.stderr.write(
    `${new Date().toISOString()} ${level} ${message}${data ? ` ${JSON.stringify(data)}` : ""}\n`,
  );

const log: Logger = {
  debug: () => {},
  info: write("info"),
  warn: write("warn"),
  error: write("error"),
};

const version = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

if (process.argv.slice(2).some((a) => a === "--version" || a === "-v")) {
  process.stdout.write(`${version}\n`);
  process.exit(0);
}

try {
  const agent = await prepareAgent({
    env: process.env,
    home: process.env["HOME"] ?? homedir(),
    registry: agentRegistry(),
    stockCatalogDir: dirname(fileURLToPath(import.meta.resolve("@outstaff/catalog/package.json"))),
    agentVersion: version,
    log,
  });

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) {
      return;
    }

    stopping = true;
    log.info("stopping", { signal });
    agent.usage.stop();
    (agent.chat?.stop() ?? Promise.resolve())
      .then(() => agent.loop.stop())
      .then(() => agent.connection.stop())
      .catch((e) => log.error("could not stop cleanly", { error: String(e) }));
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  agent.connection.start();
  log.info("connecting to the office", { person: agent.person });
  await agent.connection.whenConnected();
  log.info("connected");
  agent.usage.start();
  await agent.chat?.start().catch((e: unknown) => {
    log.error("chat requests are off: the chat connection failed", { error: String(e) });
  });

  await agent.loop.run();
  await agent.connection.stop();
  process.exitCode = agent.connection.rejection() ? 1 : 0;
} catch (e) {
  log.error(
    e instanceof StartupError
      ? e.message
      : ((e instanceof Error ? e.stack : String(e)) ?? "failed"),
  );

  process.exitCode = 1;
}
