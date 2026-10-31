#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runningVersion, type Logger } from "@outstaff/core";
import {
  StartupError,
  agentRegistry,
  createAgentRunner,
  installedRuntimes,
} from "./runner/index.js";

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

// The image's release version when the image build set it, else the package's; the office reports the same.
const version = runningVersion(
  process.env,
  (
    JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    }
  ).version,
);

if (process.argv.slice(2).some((a) => a === "--version" || a === "-v")) {
  process.stdout.write(`${version}\n`);
  process.exit(0);
}

// The runtime adapters this image carries, one per line; a person's runtime must be one of them.
if (process.argv.slice(2).includes("--runtimes")) {
  process.stdout.write(`${installedRuntimes(agentRegistry()).join("\n")}\n`);
  process.exit(0);
}

const runner = createAgentRunner({
  env: process.env,
  home: process.env["HOME"] ?? homedir(),
  registry: agentRegistry(),
  stockCatalogDir: dirname(fileURLToPath(import.meta.resolve("@outstaff/catalog/package.json"))),
  agentVersion: version,
  log,
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
