import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  PROFILE_SPECS,
  artifactsDir,
  policyOn,
  effectiveTools,
  envSecretSource,
  grantTokenKeys,
  networkGrants,
  formatIssue,
  loadTeamConfig,
  silentLogger,
  type Capability,
  type Runtime,
} from "@outstaff/core";
import { createOfficeConnection } from "../office-client/index.js";
import type { StartupOptions, PreparedAgent } from "./startup.types.js";
import { syncRepositories, createWorkspaces, type ClonedRepo } from "../repos/index.js";
import type { ToolStatus } from "../tools/index.js";
import { createAgentEnv } from "../verbs/env.js";
import { buildIdentityPrompt } from "./identity.js";
import { agentLayout } from "./layout.js";
import { createWorkLoop } from "./loop.js";
import { createUsageReporter } from "./usage.js";
import { loadCatalogs, loadToolsets } from "./catalogs.js";
import { startChat } from "./startup-chat.js";
import { StartupError, present } from "./startup-error.js";
import { buildPolicies, installDeclaredTools, renderWorkdir } from "./startup-steps.js";

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

  const layout = agentLayout(
    opts.home,
    opts.env["OUTSTAFF_SECRETS_DIR"] ?? "/run/secrets/outstaff",
  );

  // Working files: stock catalog plus the team's ejected one, laid out the way the runtime expects them.
  const catalogs = loadCatalogs(opts.stockCatalogDir, team, source.dir);
  let toolStatuses: ToolStatus[] = [];
  const rendered = renderWorkdir(team, person, layout.workDir, catalogs, log);

  const roles = { ...catalogs.stock.roles, ...catalogs.ejected?.roles };
  const role = roles[me.role];
  const toolsets = loadToolsets(opts.stockCatalogDir, roles, me.role, rendered.extends);

  // Person beats team beats toolset. Installing a tool allows nothing; its `allow` becomes policy rules below.
  const tools = effectiveTools({ toolsets, team: team.tools, person: me.tools });
  if (tools.length > 0) {
    toolStatuses = await installDeclaredTools(opts, tools, person, log);
    env.tools = toolStatuses;
  }

  const runtimeRef = team.integrations.runtime;
  const runtimeDef = opts.registry.get("runtime", runtimeRef.adapter);
  if (!runtimeDef) {
    throw new StartupError(
      `The runtime adapter "${runtimeRef.adapter}" is not installed in this build.`,
    );
  }

  // The Design canvas: roles that declare the capability (their own or an extended role's), unless the team switched it off.
  const declared = [me.role, ...(rendered.extends ?? [])].flatMap((name) => {
    const r = roles[name];
    return r ? [...r.needs, ...r.optional_needs] : [];
  });

  const canvas = declared.includes("design.canvas") && policyOn(team.policies, "design.canvas");
  const capabilities: Capability[] = canvas ? ["design.canvas"] : [];

  for (const dir of [
    layout.workDir,
    layout.reposDir,
    layout.worktreesDir,
    layout.scratchDir,
    layout.memoryDir,
    ...(canvas ? [artifactsDir(layout)] : []),
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

  const network = networkGrants(team, me);
  const { adapter: _adapter, ...rawOptions } = runtimeRef;
  const runtime = (await runtimeDef.create({
    options: runtimeDef.options.parse(rawOptions),
    secrets,
    secretKeys: [
      ...new Set([
        "OUTSTAFF_AGENT_TOKEN",
        ...grantTokenKeys(network),
        ...opts.registry.list().flatMap((d) => d.secrets("person").map((s) => s.key)),
      ]),
    ],
    team,
    log,
    fetch,
    now: () => new Date(),
  })) as Runtime;

  const { policy, chatPolicy } = buildPolicies(opts, {
    rendered,
    me,
    team,
    layout,
    toolsets,
    tools,
    capabilities,
  });

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

  const { chat, profile } = startChat(connection, { env, team, me, role, model, person, log });

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
    builtinTools: [...policy.tools.allow],
    workdir: layout.workDir,
    repos,
    workspaces: createWorkspaces({
      layout,
      repos,
      log,
      ...(opts.repositories?.git ? { git: opts.repositories.git } : {}),
    }),
    addDirs: [
      layout.reposDir,
      layout.worktreesDir,
      layout.scratchDir,
      layout.memoryDir,
      ...(canvas ? [artifactsDir(layout)] : []),
    ],
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
