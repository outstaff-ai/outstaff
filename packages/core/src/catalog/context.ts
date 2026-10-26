import type { TeamConfig } from "../config/types.js";
import { policyOn, policyValue } from "../policies/switches.js";
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
  const byRole: Record<string, PersonContext[]> = {};
  for (const role of roles) {
    byRole[role.name] = [];
  }

  for (const p of list) {
    (byRole[p.role] ??= []).push(p);
  }

  const repos: RepoContext[] = team.repos.map((r) => ({
    name: r.name,
    url: r.url,
    kind: r.kind,
    default_branch: r.default_branch,
    checks: r.checks ?? [],
    conventions: r.conventions ?? "",
    instructions: r.instructions ?? [],
  }));

  const messages = team.policies?.messages;
  const integrations = team.integrations as Record<string, { adapter: string } | undefined>;
  const has = {} as Record<Port, boolean>;
  const adapter = {} as Record<Port, string>;
  for (const port of PORTS) {
    adapter[port] = integrations[port]?.adapter ?? "";
    has[port] = adapter[port] !== "";
  }

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
    integrations: { has, adapter },
    links: { issue: "", pr: "", doc: "", ...extras.links },
    policies: {
      messages: {
        max_lines: messages?.max_lines ?? 3,
        always_link: messages?.always_link ?? true,
        omit: messages?.omit ?? DEFAULT_OMIT,
      },
      tickets: { many_prs: policyValue(team.policies, "tickets.prs_per_ticket") === "many" },
      design: { canvas: policyOn(team.policies, "design.canvas") },
    },
  };
}
