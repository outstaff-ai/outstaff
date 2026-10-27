import { homedir } from "node:os";
import { loadToolsets, runMise, verifyTools } from "@outstaff/agent";
import { effectiveTools, renderPerson, type DoctorCheck, type TeamConfig } from "@outstaff/core";
import { stockCatalogDir } from "../../catalogs.js";
import type { Context, TeamCatalogs } from "../../types.js";
import { plural } from "./check.js";
import type { Status } from "./types.js";

type Person = TeamConfig["people"][number];
type Tool = ReturnType<typeof effectiveTools>[number];

/** The roles the person's role extends, or undefined when the person does not render. */
function extendedRoles(
  team: TeamConfig,
  person: Person,
  catalogs: TeamCatalogs,
): string[] | undefined {
  try {
    return renderPerson({
      team,
      handle: person.handle,
      catalog: catalogs.stock,
      ...(catalogs.ejected ? { ejected: catalogs.ejected } : {}),
    }).extends;
  } catch {
    return undefined;
  }
}

/** Every tool the person's toolsets, the team and the person declare. */
function declaredTools(
  ctx: Context,
  team: TeamConfig,
  person: Person,
  catalogs: TeamCatalogs | undefined,
): Tool[] {
  if (!catalogs) {
    return [];
  }

  const extended = extendedRoles(team, person, catalogs);
  if (!extended) {
    return [];
  }

  const roles = { ...catalogs.stock.roles, ...catalogs.ejected?.roles };
  const toolsets = loadToolsets(stockCatalogDir(ctx), roles, person.role, extended);
  return effectiveTools({ toolsets, team: team.tools, person: person.tools });
}

const allResolve = (tools: Tool[]): DoctorCheck => ({
  name: "Tools resolve",
  status: "ok",
  detail: `${plural(tools.length, "tool")} resolve${tools.length === 1 ? "s" : ""}: ${tools.map((t) => `${t.name}@${t.version}`).join(", ")}.`,
});

/**
 * Does every tool the person's toolsets and `tools:` declare resolve through mise from the home directory, the
 * way a shim does for the agent? Only the agent's own container has them installed, so from anywhere else a
 * failure is a warning.
 */
export async function toolChecks(
  ctx: Context,
  team: TeamConfig,
  person: Person,
  catalogs: TeamCatalogs | undefined,
  inContainer: boolean,
): Promise<DoctorCheck[]> {
  const tools = declaredTools(ctx, team, person, catalogs);
  if (tools.length === 0) {
    return [];
  }

  const status: Status = inContainer ? "fail" : "warn";
  const home = ctx.home ?? homedir();
  const mise = ctx.mise ?? runMise;
  const probe = await mise(["--version"], { cwd: home, env: ctx.env });
  if (probe.code !== 0) {
    return [
      {
        name: "Tools resolve",
        status,
        detail: "mise is not installed here, so the declared tools were not checked.",
        fix: `Run \`ost doctor ${person.handle}\` inside the agent container.`,
      },
    ];
  }

  const failed = await verifyTools({ tools, home, env: ctx.env, mise });
  if (failed.length === 0) {
    return [allResolve(tools)];
  }

  return failed.map((t) => ({
    name: `Tool ${t.name} resolves`,
    status,
    detail: t.error ?? `${t.name}@${t.version} does not resolve.`,
    fix: "Restart the agent so it installs its tools and writes the global mise config; check the egress to the tool sources.",
  }));
}
