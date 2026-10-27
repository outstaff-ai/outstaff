import { delimiter } from "node:path";
import {
  buildPolicy,
  formatCatalogIssue,
  renderPerson,
  teamCommandsToPack,
  toolsetToPack,
  toolsToPacks,
  RenderError,
  type Capability,
  type Catalog,
  type RenderedWorkdir,
  type RulePack,
  type TeamConfig,
  type Toolset,
  type EffectiveTool,
  type Layout,
  type Logger,
  type Policy,
} from "@outstaff/core";
import type { StartupOptions } from "./startup.types.js";
import { installTools, type ToolStatus } from "#/tools/index.js";
import { StartupError } from "./startup-error.js";

/** The runtime starts its children with the process environment, so the shims go on this process's PATH. */
function addToPath(shimsDir: string): void {
  const parts = (process.env["PATH"] ?? "").split(delimiter);
  if (!parts.includes(shimsDir)) {
    process.env["PATH"] = [shimsDir, ...parts].filter(Boolean).join(delimiter);
  }
}

/** The person's working files, rendered from the catalogs. Render problems are a startup error. */
export function renderWorkdir(
  team: TeamConfig,
  person: string,
  workDir: string,
  catalogs: { stock: Catalog; ejected?: Catalog },
  log: Logger,
): RenderedWorkdir {
  let rendered: RenderedWorkdir;
  try {
    rendered = renderPerson({
      team,
      handle: person,
      workdir: workDir,
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

  return rendered;
}

/** Installs the declared tools and puts their shims on this process's PATH. A tool that is not usable stops the start. */
export async function installDeclaredTools(
  opts: StartupOptions,
  tools: EffectiveTool[],
  person: string,
  log: Logger,
): Promise<ToolStatus[]> {
  const installed = await installTools({
    tools,
    home: opts.home,
    env: opts.env,
    log,
    ...(opts.tools?.mise ? { mise: opts.tools.mise } : {}),
  });

  const toolStatuses = installed.statuses;
  const unavailable = toolStatuses.filter((x) => x.state === "unavailable");
  if (unavailable.length > 0) {
    throw new StartupError(
      `Tools declared for ${person} are not usable:\n${unavailable.map((t) => t.error ?? `${t.name}@${t.version} could not be installed`).join("\n")}\nFix the declaration or the egress to the tool sources and restart.`,
    );
  }

  (opts.tools?.addToPath ?? addToPath)(installed.shimsDir);
  return toolStatuses;
}

/** The person's permission policy, and the one chat sessions run under. */
export function buildPolicies(
  opts: StartupOptions,
  {
    rendered,
    me,
    team,
    layout,
    toolsets,
    tools,
    capabilities,
  }: {
    rendered: RenderedWorkdir;
    me: TeamConfig["people"][number];
    team: TeamConfig;
    layout: Layout;
    toolsets: Toolset[];
    tools: EffectiveTool[];
    capabilities: Capability[];
  },
): { policy: Policy; chatPolicy: Policy } {
  const packs: RulePack[] = [...opts.registry.rulePacks("person", team)];
  for (const ts of toolsets) {
    packs.push(toolsetToPack(ts));
  }

  packs.push(...toolsToPacks(tools));

  const teamPack = teamCommandsToPack(team.policies?.commands);
  if (teamPack) {
    packs.push(teamPack);
  }

  const policy = buildPolicy({
    profile: rendered.profile,
    person: me,
    team,
    layout,
    packs,
    capabilities,
  });

  // Chat sessions run beside the active item, so they get a profile that cannot change its repositories.
  const chatPolicy = buildPolicy({
    profile: "chat",
    packsOf: rendered.profile,
    person: me,
    team,
    layout,
    packs,
  });

  return { policy, chatPolicy };
}
