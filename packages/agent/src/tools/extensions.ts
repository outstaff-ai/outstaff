import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  parseToolExtension,
  silentLogger,
  type EffectiveTool,
  type HostCli,
  type HostCliExtensions,
  type InstalledExtension,
  type Logger,
  type ToolExtension,
} from "@outstaff/core";
import type { ExtensionStatus, InstallExtensionsOptions } from "./types.js";

/** Declared extension (`tool:owner/name`) to the ref and directory it was installed at. */
type State = Record<string, { ref: string; dir: string }>;

/** Where the agent records the extensions it installed, beside its tools' install state. */
export const extensionsStateFile = (home: string) =>
  join(home, ".config/outstaff/tools/extensions.json");

function readState(file: string): State {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as State;
  } catch {
    return {};
  }
}

/** The last lines of the CLI's output, which say why an install failed. */
const reasonOf = (output: string) =>
  output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-2)
    .join(" ") || "no output";

interface Declared {
  tool: string;
  text: string;
  ext: ToolExtension | undefined;
}

const declaredOf = (tools: EffectiveTool[]): Declared[] =>
  tools.flatMap((t) =>
    (t.extensions ?? []).map((text) => ({ tool: t.name, text, ext: parseToolExtension(text) })),
  );

/** Why an extension cannot be installed at all, before running anything; undefined when it can be tried. */
function refusal(d: Declared, cli: HostCli | undefined): string | undefined {
  if (!cli || d.tool !== cli.command) {
    return `${d.tool} takes no extensions here: only the code host's CLI${cli ? ` (${cli.command})` : ""} does.`;
  }

  if (!cli.extensions) {
    return `${cli.command} takes no extensions.`;
  }

  if (!d.ext) {
    return `${d.text} is not <owner>/<repository>@<ref>.`;
  }

  return cli.extensions.command(d.ext.name)
    ? undefined
    : `${d.ext.owner}/${d.ext.name} is not a ${cli.command} extension: its repository name does not give a command.`;
}

/** What installing one extension needs: the CLI's extension declaration, and the install state before and after. */
interface Run {
  opts: InstallExtensionsOptions;
  extensions: HostCliExtensions;
  before: State;
  after: State;
  log: Logger;
}

/** Keeps one extension installed at its ref, or installs it again; records it in `after` when it is in place. */
async function ensure(run: Run, d: Declared, ext: ToolExtension): Promise<ExtensionStatus> {
  const { opts, extensions, before, after, log } = run;
  const key = `${d.tool}:${ext.owner}/${ext.name}`.toLowerCase();
  const dir = extensions.dir(ext, opts.env);
  const base = { tool: d.tool, extension: d.text, command: extensions.command(ext.name)! };
  const kept = before[key];
  if (kept?.ref === ext.ref && existsSync(dir)) {
    after[key] = kept;
    return { ...base, state: "cached" };
  }

  rmSync(dir, { recursive: true, force: true });
  const r = await opts.run(ext, extensions.install(ext));
  if (r.code === 0 && existsSync(dir)) {
    after[key] = { ref: ext.ref, dir };
    log.info("tool extension installed", { tool: d.tool, extension: d.text });
    return { ...base, state: "installed" };
  }

  const error = `${d.text} could not be installed: ${reasonOf(r.output)}`;
  log.error("tool extension unavailable", { tool: d.tool, extension: d.text, reason: error });
  return { ...base, state: "unavailable", error };
}

/** Removes the extensions installed before that are not in place now, and records those that are. */
function settle(file: string, before: State, after: State): void {
  for (const [key, was] of Object.entries(before)) {
    if (!after[key]) {
      rmSync(was.dir, { recursive: true, force: true });
    }
  }

  if (Object.keys(before).length > 0 || Object.keys(after).length > 0) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(after));
  }
}

/**
 * Installs the pinned extensions the effective tools declare, with the code host's CLI, under the agent's home: an
 * extension already installed at its ref is kept, one at another ref (or missing) is installed again, and one no
 * longer declared is removed. A failure is reported in the extension's status; it never stops the start.
 */
export async function installExtensions(
  opts: InstallExtensionsOptions,
): Promise<ExtensionStatus[]> {
  const file = extensionsStateFile(opts.home);
  const before = readState(file);
  const after: State = {};
  const statuses: ExtensionStatus[] = [];
  const log = opts.log ?? silentLogger;
  for (const d of declaredOf(opts.tools)) {
    const refused = refusal(d, opts.cli);
    const extensions = opts.cli?.extensions;
    if (refused !== undefined || !extensions || !d.ext) {
      const error = refused ?? `${d.text} cannot be installed.`;
      statuses.push({ tool: d.tool, extension: d.text, state: "unavailable", error });
      continue;
    }

    statuses.push(await ensure({ opts, extensions, before, after, log }, d, d.ext));
  }

  settle(file, before, after);
  return statuses;
}

/** The extensions that are usable, with the command each adds. */
export const usableExtensions = (statuses: ExtensionStatus[]): InstalledExtension[] =>
  statuses.flatMap((s) =>
    s.state !== "unavailable" && s.command
      ? [{ tool: s.tool, command: s.command, extension: s.extension }]
      : [],
  );
