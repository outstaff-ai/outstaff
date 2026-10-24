#!/usr/bin/env node
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StartupError, agentRegistry, prepareAgent } from "@outstaff/agent";
import type { Logger } from "@outstaff/core";
import { scriptedRuntime } from "./index.js";

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

// The agent's own bin, with one more adapter: the scripted runtime. Only the agent-e2e image has this file.
try {
  const agent = await prepareAgent({
    env: process.env,
    home: process.env["HOME"] ?? homedir(),
    registry: agentRegistry().register(scriptedRuntime),
    stockCatalogDir: dirname(fileURLToPath(import.meta.resolve("@outstaff/catalog/package.json"))),
    agentVersion: "e2e",
    log,
    // The developer toolset installs pnpm, python and go with mise at start. The scripted runtime needs none of
    // them, and the test must not download anything, so every install is reported as done.
    tools: { mise: async () => ({ code: 0, stdout: "", stderr: "" }) },
  });

  const shutdown = (signal: string) => {
    log.info("stopping", { signal });
    agent.usage.stop();
    agent.loop
      .stop()
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
