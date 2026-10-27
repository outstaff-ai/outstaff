import { effectiveTools } from "@outstaff/core";
import type { StartupOptions, PreparedAgent } from "./startup.types.js";
import { createAgentEnv } from "#/verbs/env.js";
import { buildIdentityPrompt } from "./identity.js";
import { agentLayout } from "./layout.js";
import { loadCatalogs, loadToolsets } from "./catalogs.js";
import { startChat } from "./startup-chat.js";
import { loadStartupContext, officeConnection } from "./startup-context.js";
import { createRuntime, runtimeAdapter, writeWorkdirFiles } from "./startup-runtime.js";
import { buildPolicies, renderWorkdir } from "./startup-steps.js";
import {
  cloneRepositories,
  installTools,
  prepareDirs,
  roleCapabilities,
  usageReporter,
  workLoop,
} from "./startup-work.js";

const DEFAULT_SECRETS_DIR = "/run/secrets/outstaff";

/**
 * Everything the agent needs before it takes work: the team, the person's rendered working files, the permission
 * policy, the runtime and the office connection. Nothing connects until the caller starts the connection.
 */
export async function prepareAgent(opts: StartupOptions): Promise<PreparedAgent> {
  const ctx = await loadStartupContext(opts);
  const { team, me, person, secrets, log } = ctx;
  const connection = officeConnection(ctx);
  const env = await createAgentEnv({
    team,
    person,
    registry: opts.registry,
    secrets,
    office: connection,
    log,
  });

  const layout = agentLayout(opts.home, opts.env["OUTSTAFF_SECRETS_DIR"] ?? DEFAULT_SECRETS_DIR);

  // Working files: stock catalog plus the team's ejected one, laid out the way the runtime expects them.
  const catalogs = loadCatalogs(opts.stockCatalogDir, team, ctx.teamDir);
  const rendered = renderWorkdir(team, person, layout.workDir, catalogs, log);
  const roles = { ...catalogs.stock.roles, ...catalogs.ejected?.roles };
  const role = roles[me.role];
  const toolsets = loadToolsets(opts.stockCatalogDir, roles, me.role, rendered.extends);

  // Person beats team beats toolset. Installing a tool allows nothing; its `allow` becomes policy rules below.
  const tools = effectiveTools({ toolsets, team: team.tools, person: me.tools });
  const toolStatuses = await installTools(ctx, env, tools);
  const runtimeDef = runtimeAdapter(ctx);
  const capabilities = roleCapabilities(ctx, roles, rendered.extends);
  const addDirs = prepareDirs(layout, capabilities);
  const repos = await cloneRepositories(ctx, env, rendered, layout);
  writeWorkdirFiles(runtimeDef, rendered, layout.workDir);
  const runtime = await createRuntime(ctx, runtimeDef);
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
  const usage = usageReporter(ctx, connection, runtime);
  const started = startChat(connection, { env, team, me, role, model, person, log });
  const loop = workLoop(ctx, {
    ...started,
    connection,
    env,
    layout,
    runtime,
    usage,
    policy,
    chatPolicy,
    systemPrompt,
    repos,
    addDirs,
    model,
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
    ...(started.chat ? { chat: started.chat } : {}),
  };
}
