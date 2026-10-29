#!/usr/bin/env node
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  StartupError,
  agentRegistry,
  createAgentRunner,
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
const runner = createAgentRunner({
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

process.on("SIGTERM", () => runner.stop("SIGTERM"));
process.on("SIGINT", () => runner.stop("SIGINT"));

try {
  process.exitCode = await runner.run();
} catch (e) {
  log.error(
    e instanceof StartupError
      ? e.message
      : ((e instanceof Error ? e.stack : String(e)) ?? "failed"),
  );

  process.exitCode = 1;
}
