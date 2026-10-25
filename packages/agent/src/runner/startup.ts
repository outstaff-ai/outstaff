import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import {
  PROFILE_SPECS,
  policyOn,
  buildPolicy,
  effectiveTools,
  envSecretSource,
  formatCatalogIssue,
  formatIssue,
  loadCatalog,
  loadTeamConfig,
  loadToolset,
  renderPerson,
  silentLogger,
  teamCommandsToPack,
  toolsetToPack,
  toolsToPacks,
  CatalogError,
  RenderError,
  type AdapterRegistry,
  type Catalog,
  type Logger,
  type Policy,
  type RenderedWorkdir,
  type RulePack,
  type Runtime,
  type SecretSource,
  type TeamConfig,
  type Toolset,
} from "@outstaff/core";
import { createOfficeConnection, type OfficeConnection } from "../office-client/index.js";
import {
  syncRepositories,
  createWorkspaces,
  type ClonedRepo,
  type SyncRepositoriesOptions,
} from "../repos/index.js";
import { installTools, type MiseRunner, type ToolStatus } from "../tools/index.js";
import { createAgentEnv } from "../verbs/env.js";
import type { AgentEnv } from "../verbs/types.js";
import { buildIdentityPrompt } from "./identity.js";
import { createChatRelay, type ChatRelay } from "./chat.js";
import { createProfilePublisher, type ProfilePublisher } from "./profile.js";
import { agentLayout } from "./layout.js";
import { createWorkLoop, type WorkLoop } from "./loop.js";
import { createUsageReporter, type UsageReporter } from "./usage.js";

export interface StartupOptions {
  /** The container environment: OUTSTAFF_PERSON, OUTSTAFF_OFFICE_URL and the team location variables. */
  env: NodeJS.ProcessEnv;

  /** The agent's home directory; the working files render into `<home>/work`. */
  home: string;
  registry: AdapterRegistry;

  /** Root of the installed stock catalog package. */
  stockCatalogDir: string;
  agentVersion: string;
  cwd?: string;

  /** Defaults to `envSecretSource(env)`. */
  secrets?: SecretSource;
  log?: Logger;

  /** Milliseconds between usage probes while idle. Default 600000 (10 minutes). */
  usageProbeEveryMs?: number;

  /** Replaces the WebSocket connection (tests only). */
  connection?: OfficeConnection;

  /** Overrides for cloning: the remote of each repo, the credential helper command, the git runner (tests only). */
  repositories?: Pick<SyncRepositoriesOptions, "remoteUrl" | "helper" | "git">;

  /** Overrides for tool installation: the mise runner and what to do with the shims directory (tests only). */
  tools?: { mise?: MiseRunner; addToPath?: (shimsDir: string) => void };
}

export interface PreparedAgent {
  person: string;
  team: TeamConfig;
  connection: OfficeConnection;
  loop: WorkLoop;

  /** Forwards usage to the office. Not started by `prepareAgent`: call `start()` once connected. */
  usage: UsageReporter;
  env: AgentEnv;
  runtime: Runtime;
  rendered: RenderedWorkdir;
  policy: Policy;
  systemPrompt: string;
  workdir: string;

  /** The repos cloned for the person, one per grant. */
  repos: ClonedRepo[];

  /** The declared tools and whether each is available. */
  tools: ToolStatus[];

  /** Listens on the agent's own chat identity; absent when the team has no chat or it cannot start. */
  chat?: ChatRelay;
}

/** Why the agent cannot start, in words an operator can act on. */
export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartupError";
  }
}

const present = (env: NodeJS.ProcessEnv, key: string): string => {
  const v = env[key];
  if (!v) {
    throw new StartupError(`${key} is not set.`);
  }

  return v;
};

function loadCatalogs(
  stockDir: string,
  team: TeamConfig,
  teamDir: string,
): { stock: Catalog; ejected?: Catalog } {
  try {
    const stock = loadCatalog(stockDir);
    const dir = resolve(teamDir, team.catalog.path);
    const ejected =
      existsSync(dir) && statSync(dir).isDirectory()
        ? loadCatalog(dir, { version: team.catalog.version })
        : undefined;

    return { stock, ...(ejected ? { ejected } : {}) };
  } catch (e) {
    if (e instanceof CatalogError) {
      throw new StartupError(
        `The catalog cannot be loaded:\n${e.issues.map(formatCatalogIssue).join("\n")}`,
      );
    }

    throw e;
  }
}

/** The toolsets of a role and the roles it extends, in the order they apply, from the stock catalog's `toolsets/`. */
export function loadToolsets(
  stockCatalogDir: string,
  roles: Record<string, { toolset?: string | undefined } | undefined>,
  role: string,
  extended: string[],
): Toolset[] {
  const names = [...new Set([role, ...extended].map((r) => roles[r]?.toolset).filter((t) => t))];
  const toolsets: Toolset[] = [];
  for (const name of names as string[]) {
    const file = join(stockCatalogDir, "toolsets", `${name}.yaml`);
    if (existsSync(file)) {
      toolsets.push(loadToolset(file));
    }
  }

  return toolsets;
}

/** The runtime starts its children with the process environment, so the shims go on this process's PATH. */
function addToPath(shimsDir: string): void {
  const parts = (process.env["PATH"] ?? "").split(delimiter);
  if (!parts.includes(shimsDir)) {
    process.env["PATH"] = [shimsDir, ...parts].filter(Boolean).join(delimiter);
  }
}

/**
 * Everything the agent needs before it takes work: the team, the person's rendered working files, the permission
 * policy, the runtime and the office connection. Nothing connects until the caller starts the connection.
 */
export async function prepareAgent(opts: StartupOptions): Promise<PreparedAgent> {
  const log = opts.log ?? silentLogger;
  const person = present(opts.env, "OUTSTAFF_PERSON");
  const secrets = opts.secrets ?? envSecretSource(opts.env);

  const loaded = await loadTeamConfig({
    env: opts.env,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });

  if (!loaded.ok) {
    throw new StartupError(
      `The team config is invalid:\n${loaded.issues.map(formatIssue).join("\n")}`,
    );
  }

  const { config: team, source } = loaded;
  const me = team.people.find((p) => p.handle === person);
  if (!me) {
    throw new StartupError(`${person} is not a person of team ${team.team.name}.`);
  }

  const connection =
    opts.connection ??
    createOfficeConnection({
      url: present(opts.env, "OUTSTAFF_OFFICE_URL"),
      person,
      token: secrets.require("OUTSTAFF_AGENT_TOKEN"),
      agentVersion: opts.agentVersion,
      logger: log,
    });

  const env = await createAgentEnv({
    team,
    person,
    registry: opts.registry,
    secrets,
    office: connection,
    log,
  });

  // Working files: stock catalog plus the team's ejected one, laid out the way the runtime expects them.
  const catalogs = loadCatalogs(opts.stockCatalogDir, team, source.dir);
  let toolStatuses: ToolStatus[] = [];
  let rendered: RenderedWorkdir;
  try {
    rendered = renderPerson({
      team,
      handle: person,
      catalog: catalogs.stock,
      ...(catalogs.ejected ? { ejected: catalogs.ejected } : {}),
    });
  } catch (e) {
    if (e instanceof RenderError) {
      throw new StartupError(
        `The working files cannot be rendered:\n${e.issues.map(formatCatalogIssue).join("\n")}`,
      );
    }

    throw e;
  }

  for (const w of rendered.warnings) {
    log.warn(w.message);
  }

  const roles = { ...catalogs.stock.roles, ...catalogs.ejected?.roles };
  const role = roles[me.role];
  const toolsets = loadToolsets(opts.stockCatalogDir, roles, me.role, rendered.extends);

  // Person beats team beats toolset. Installing a tool allows nothing; its `allow` becomes policy rules below.
  const tools = effectiveTools({ toolsets, team: team.tools, person: me.tools });
  if (tools.length > 0) {
    const installed = await installTools({
      tools,
      home: opts.home,
      env: opts.env,
      log,
      ...(opts.tools?.mise ? { mise: opts.tools.mise } : {}),
    });

    toolStatuses = installed.statuses;
    const unavailable = toolStatuses.filter((x) => x.state === "unavailable");
    if (unavailable.length > 0) {
      throw new StartupError(
        `Tools declared for ${person} are not usable:\n${unavailable.map((t) => t.error ?? `${t.name}@${t.version} could not be installed`).join("\n")}\nFix the declaration or the egress to the tool sources and restart.`,
      );
    }

    env.tools = toolStatuses;
    (opts.tools?.addToPath ?? addToPath)(installed.shimsDir);
  }

  const runtimeRef = team.integrations.runtime;
  const runtimeDef = opts.registry.get("runtime", runtimeRef.adapter);
  if (!runtimeDef) {
    throw new StartupError(
      `The runtime adapter "${runtimeRef.adapter}" is not installed in this build.`,
    );
  }

  const layout = agentLayout(
    opts.home,
    opts.env["OUTSTAFF_SECRETS_DIR"] ?? "/run/secrets/outstaff",
  );

  for (const dir of [
    layout.workDir,
    layout.reposDir,
    layout.worktreesDir,
    layout.scratchDir,
    layout.memoryDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  let repos: ClonedRepo[] = [];
  if (env.vcs) {
    repos = await syncRepositories({
      team,
      person,
      vcs: env.vcs,
      profile: rendered.profile,
      reposDir: layout.reposDir,
      log,
      ...opts.repositories,
    });
  } else {
    log.info("no code host for this person, so no repositories are cloned", {
      reason: env.unavailable?.vcs ?? "no vcs integration is configured",
    });
  }

  const files = runtimeDef.workdirLayout
    ? runtimeDef.workdirLayout(rendered.files)
    : rendered.files;

  for (const [path, text] of files) {
    const target = join(layout.workDir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }

  const { adapter: _adapter, ...rawOptions } = runtimeRef;
  const runtime = (await runtimeDef.create({
    options: runtimeDef.options.parse(rawOptions),
    secrets,
    secretKeys: [
      ...new Set([
        "OUTSTAFF_AGENT_TOKEN",
        ...opts.registry.list().flatMap((d) => d.secrets("person").map((s) => s.key)),
      ]),
    ],
    team,
    log,
    fetch,
    now: () => new Date(),
  })) as Runtime;

  const packs: RulePack[] = [...opts.registry.rulePacks("person", team)];
  for (const ts of toolsets) {
    packs.push(toolsetToPack(ts));
  }

  packs.push(...toolsToPacks(tools));

  const teamPack = teamCommandsToPack(team.policies?.commands);
  if (teamPack) {
    packs.push(teamPack);
  }

  const policy = buildPolicy({ profile: rendered.profile, person: me, team, layout, packs });

  // Chat sessions run beside the active item, so they get a profile that cannot disturb it.
  const chatPolicy = buildPolicy({ profile: "chat", person: me, team, layout, packs });
  const systemPrompt = buildIdentityPrompt({
    team,
    handle: person,
    ...(role ? { role: { title: role.title, summary: role.summary } } : {}),
  });

  const model = me.model ?? role?.default_model;
  const thresholds = team.policies?.usage;
  const usage = createUsageReporter({
    send: (windows) => connection.usage(windows),
    runtime,
    ...(thresholds
      ? {
          thresholds: {
            defer_scheduled_at: thresholds.defer_scheduled_at,
            pause_automatic_at: thresholds.pause_automatic_at,
          },
        }
      : {}),
    ...(opts.usageProbeEveryMs === undefined ? {} : { probeEveryMs: opts.usageProbeEveryMs }),
    log,
  });

  let chat: ChatRelay | undefined;
  let profile: ProfilePublisher | undefined;
  const chatPort = env.chat;
  if (chatPort?.setAgentProfile && policyOn(team.policies, "chat.profile")) {
    profile = createProfilePublisher({
      chat: { ...chatPort, setAgentProfile: chatPort.setAgentProfile.bind(chatPort) },
      office: connection,
      team,
      who: {
        name: me.name,
        role: role?.title ?? me.role,
        ...(role?.summary ? { description: role.summary } : {}),
        ...(model ? { model } : {}),
      },
      log,
      ...(env.tracker ? { tracker: env.tracker } : {}),
    });
  }

  if (env.chat) {
    chat = createChatRelay({
      ...(profile ? { profile } : {}),
      chat: env.chat,
      office: connection,
      team,
      person,
      log,
      ...(env.tracker ? { tracker: env.tracker } : {}),
    });
  } else if (env.unavailable?.chat) {
    log.warn("chat requests are off", { reason: env.unavailable.chat });
  }

  const loop = createWorkLoop({
    ...(profile ? { profile } : {}),
    ...(chat
      ? { chat, chatSession: { policy: chatPolicy, builtinTools: [...PROFILE_SPECS.chat.tools] } }
      : {}),
    office: connection,
    usage,
    runtime,
    env: { ...env, policy, layout },
    systemPrompt,
    policy,
    builtinTools: [...PROFILE_SPECS[rendered.profile].tools],
    workdir: layout.workDir,
    workspaces: createWorkspaces({
      layout,
      repos,
      log,
      ...(opts.repositories?.git ? { git: opts.repositories.git } : {}),
    }),
    addDirs: [layout.reposDir, layout.worktreesDir, layout.scratchDir, layout.memoryDir],
    ...(model ? { model } : {}),
    ...(team.policies ? { policies: team.policies } : {}),
    log,
  });

  return {
    person,
    team,
    connection,
    loop,
    usage,
    env,
    runtime,
    rendered,
    policy,
    systemPrompt,
    workdir: layout.workDir,
    repos,
    tools: toolStatuses,
    ...(chat ? { chat } : {}),
  };
}
