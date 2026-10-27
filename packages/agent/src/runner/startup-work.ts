import { mkdirSync } from "node:fs";
import {
  CAPABILITIES,
  CAPABILITY_PORT,
  PROFILE_SPECS,
  artifactsDir,
  capabilityOn,
  type Capability,
  type EffectiveTool,
  type Layout,
  type RenderedWorkdir,
  type Runtime,
} from "@outstaff/core";
import type { OfficeConnection } from "#/office-client/index.js";
import { createWorkspaces, syncRepositories, type ClonedRepo } from "#/repos/index.js";
import type { ToolStatus } from "#/tools/index.js";
import type { AgentEnv } from "#/verbs/types.js";
import { createWorkLoop } from "./loop.js";
import type { WorkLoop } from "./loop.types.js";
import { installDeclaredTools } from "./startup-steps.js";
import type { LoopParts, RuntimeAdapter, StartupContext } from "./startup.types.js";
import type { UsageReporter } from "./types.js";
import { createUsageReporter } from "./usage.js";

type Roles = Record<string, { needs: string[]; optional_needs: string[] } | undefined>;

const isCapability = (name: string): name is Capability =>
  (CAPABILITIES as readonly string[]).includes(name);

/** Installs the declared tools and notes their status in the verbs' environment. Installing a tool allows nothing. */
export async function installTools(
  { opts, person, log }: StartupContext,
  env: AgentEnv,
  tools: EffectiveTool[],
): Promise<ToolStatus[]> {
  if (tools.length === 0) {
    return [];
  }

  const statuses = await installDeclaredTools(opts, tools, person, log);
  env.tools = statuses;

  return statuses;
}

/**
 * The runtime capabilities the person's roles declare (their own or an extended role's, needed or optional), that
 * their runtime provides and the team has not switched off.
 */
export function roleCapabilities(
  { team, me }: StartupContext,
  roles: Roles,
  extended: string[] | undefined,
  runtime: RuntimeAdapter,
): Capability[] {
  const declared = [me.role, ...(extended ?? [])].flatMap((name) => {
    const r = roles[name];
    return r ? [...r.needs, ...r.optional_needs] : [];
  });

  return [...new Set(declared)]
    .filter(isCapability)
    .filter(
      (cap) =>
        CAPABILITY_PORT[cap] === "runtime" &&
        runtime.capabilities.includes(cap) &&
        capabilityOn(team.policies, cap),
    );
}

/** The directories the runtime may use besides the working directory, created with it. */
export function prepareDirs(layout: Layout, capabilities: Capability[]): string[] {
  const addDirs = [
    layout.reposDir,
    layout.worktreesDir,
    layout.scratchDir,
    layout.memoryDir,
    ...(capabilities.includes("design.canvas") ? [artifactsDir(layout)] : []),
  ];

  for (const dir of [layout.workDir, ...addDirs]) {
    mkdirSync(dir, { recursive: true });
  }

  return addDirs;
}

/** Clones the repositories the person has a grant on; without a code host there are none. */
export async function cloneRepositories(
  { opts, team, person, log }: StartupContext,
  env: AgentEnv,
  rendered: RenderedWorkdir,
  layout: Layout,
): Promise<ClonedRepo[]> {
  if (!env.vcs) {
    log.info("no code host for this person, so no repositories are cloned", {
      reason: env.unavailable?.vcs ?? "no vcs integration is configured",
    });

    return [];
  }

  return syncRepositories({
    team,
    person,
    vcs: env.vcs,
    profile: rendered.profile,
    reposDir: layout.reposDir,
    log,
    ...opts.repositories,
  });
}

export function usageReporter(
  { opts, team, log }: StartupContext,
  connection: OfficeConnection,
  runtime: Runtime,
): UsageReporter {
  const thresholds = team.policies?.usage;

  return createUsageReporter({
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
}

/** The chat parts of the loop: the relay, and the chat session it runs messages in. */
const chatParts = ({ chat, profile, chatPolicy }: LoopParts) => ({
  ...(profile ? { profile } : {}),
  ...(chat
    ? { chat, chatSession: { policy: chatPolicy, builtinTools: [...PROFILE_SPECS.chat.tools] } }
    : {}),
});

export function workLoop({ opts, team, log }: StartupContext, parts: LoopParts): WorkLoop {
  const { layout, policy, repos, model } = parts;

  return createWorkLoop({
    ...chatParts(parts),
    office: parts.connection,
    usage: parts.usage,
    runtime: parts.runtime,
    env: { ...parts.env, policy, layout },
    systemPrompt: parts.systemPrompt,
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
    addDirs: parts.addDirs,
    ...(model ? { model } : {}),
    ...(team.policies ? { policies: team.policies } : {}),
    log,
  });
}
