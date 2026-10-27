import type { TeamConfig } from "#/config/types.js";
import { policyOn, policyValue } from "#/policies/switches.js";
import { PRESET_MOVES_TICKETS } from "#/workflow/presets.js";
import type {
  CatalogContext,
  ContextExtras,
  PersonContext,
  RepoContext,
  RoleInfo,
} from "./types.js";

export const PORTS = ["tracker", "knowledge", "vcs", "chat", "runtime", "avatars"] as const;
type Port = (typeof PORTS)[number];

const DEFAULT_OMIT = ["ci", "mergeability", "hashes"];

const toPerson = (p: TeamConfig["people"][number], roles: RoleInfo[]): PersonContext => {
  const info = roles.find((r) => r.name === p.role);
  return {
    handle: p.handle,
    name: p.name,
    pronouns: p.pronouns ?? "",
    role: p.role,
    role_title: info?.title ?? "",
    role_summary: info?.summary ?? "",
    model: p.model ?? "",
  };
};

export function buildContext(team: TeamConfig, extras: ContextExtras = {}): CatalogContext {
  const roles = extras.roles ?? [];
  const list = team.people.map((p) => toPerson(p, roles));
  const byRole = peopleByRole(list, roles);
  const repos = team.repos.map(toRepo);

  return {
    team: { name: team.team.name, product: team.team.product ?? "" },
    repos: {
      list: repos,
      primary: repos.find((r) => r.kind === "primary") ?? null,
      many: repos.length > 1,
      has_checks: repos.some((r) => r.checks.length > 0),
      has_conventions: repos.some((r) => r.conventions !== ""),
    },
    people: { list, byRole },
    roles: roles.map((r) => ({
      name: r.name,
      title: r.title,
      summary: r.summary,
      people: byRole[r.name] ?? [],
    })),
    humans: {
      list: (team.humans ?? []).map((h) => ({ name: h.name })),
      has: (team.humans ?? []).length > 0,
      default_trust: team.humans === undefined,
    },
    integrations: integrationsOf(team),
    links: { issue: "", pr: "", doc: "", ...extras.links },
    policies: policiesOf(team),
  };
}

/** Every known role, held or not, with the people who hold it; a role the catalog lacks still lists its people. */
function peopleByRole(list: PersonContext[], roles: RoleInfo[]): Record<string, PersonContext[]> {
  const byRole: Record<string, PersonContext[]> = {};
  for (const role of roles) {
    byRole[role.name] = [];
  }

  for (const p of list) {
    (byRole[p.role] ??= []).push(p);
  }

  return byRole;
}

const toRepo = (r: TeamConfig["repos"][number]): RepoContext => ({
  name: r.name,
  url: r.url,
  kind: r.kind,
  default_branch: r.default_branch,
  checks: r.checks ?? [],
  conventions: r.conventions ?? "",
  instructions: r.instructions ?? [],
});

/** Which ports the team configures, and the adapter of each ("" for none). */
function integrationsOf(team: TeamConfig): CatalogContext["integrations"] {
  const integrations = team.integrations as Record<string, { adapter: string } | undefined>;
  const has = {} as Record<Port, boolean>;
  const adapter = {} as Record<Port, string>;
  for (const port of PORTS) {
    adapter[port] = integrations[port]?.adapter ?? "";
    has[port] = adapter[port] !== "";
  }

  return { has, adapter };
}

/** Whether a ticket may have several pull requests, and whether the office makes the routine ticket moves. */
const ticketsOf = (team: TeamConfig): CatalogContext["policies"]["tickets"] => ({
  many_prs: policyValue(team.policies, "tickets.prs_per_ticket") === "many",
  office_moves: PRESET_MOVES_TICKETS[team.workflow?.preset ?? "kanban"],
});

function policiesOf(team: TeamConfig): CatalogContext["policies"] {
  const messages = team.policies?.messages;

  return {
    messages: {
      max_lines: messages?.max_lines ?? 3,
      always_link: messages?.always_link ?? true,
      omit: messages?.omit ?? DEFAULT_OMIT,
    },
    tickets: ticketsOf(team),
    design: { canvas: policyOn(team.policies, "design.canvas") },
  };
}
