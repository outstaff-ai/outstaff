#!/usr/bin/env node
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  StartupError,
  agentRegistry,
  prepareAgent,
  reportAgentChecks,
  runMise,
  withGlobalConfig,
} from "@outstaff/agent";
import { AdapterRegistry, type Logger } from "@outstaff/core";
import { scriptedRuntime, stubChat } from "./index.js";

const write = (level: string) => (message: string, data?: Record<string, unknown>) =>
  process.stderr.write(
    `${new Date().toISOString()} ${level} ${message}${data ? ` ${JSON.stringify(data)}` : ""}\n`,
  );

/** Installing is reported as done; `mise current` answers from the global config the agent wrote. */
const declared = withGlobalConfig(async () => ({ code: 0, stdout: "", stderr: "" }));

const log: Logger = {
  debug: () => {},
  info: write("info"),
  warn: write("warn"),
  error: write("error"),
};

// The agent's own bin, with two changes: the scripted runtime is one more adapter, and the stub workspace takes the
// place of Slack. Only the agent-e2e image has this file.
const registry = new AdapterRegistry();
for (const def of agentRegistry().list()) {
  if (def.port !== "chat") {
    registry.register(def);
  }
}

registry.register(scriptedRuntime).register(stubChat);
try {
  const agent = await prepareAgent({
    env: process.env,
    home: process.env["HOME"] ?? homedir(),
    registry,
    stockCatalogDir: dirname(fileURLToPath(import.meta.resolve("@outstaff/catalog/package.json"))),
    agentVersion: "e2e",
    log,
    // The developer toolset installs pnpm, yarn, python and go with mise at start, and the test must not
    // download anything. The image (agent-e2e) carries pnpm, so mise really answers for it, and the global config
    // the agent wrote must make its shim work; installing and the other tools are reported as done.
    tools: {
      mise: (args, opts) =>
        args[1]?.startsWith("pnpm") ? runMise(args, opts) : declared(args, opts),
    },
  });

  const shutdown = (signal: string) => {
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
  void reportAgentChecks(agent, process.env, process.env["HOME"] ?? homedir(), log);
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
