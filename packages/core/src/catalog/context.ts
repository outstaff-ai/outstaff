import type { TeamConfig } from "../config/schema.js";

/**
 * The values a template can use. Every key below always exists, so a template
 * may test it with {{#if}}; an absent value is "" (or null for objects).
 *
 * One context for every catalog file; it never contains a person, because a role
 * reads the same for everyone who holds it. Who the agent is comes from data
 * at runtime.
 *
 *   team.name, team.product
 *   repos.list[] {name,url,kind,default_branch}, repos.primary (null when none)
 *   people.list[] {handle,name,pronouns,role,role_title,role_summary,model},
 *   people.byRole.<role>[] (a key, possibly empty, for every catalog role)
 *   roles[] {name,title,summary,people[]} for every catalog role; people is the
 *                  same list as people.byRole.<name>, so a template can nest it
 *   humans.list[] {name}, humans.has, humans.default_trust (true when the team
 *                  gives no `humans:` list); no identities or ids
 *   integrations.has.<port> (boolean), integrations.adapter.<port> (name or "")
 *   links.<name>   url templates with {key} slots, for example "{base}/{key}";
 *                  adapters fill them later. issue, pr and doc always exist.
 *   policies.messages.{max_lines,always_link,omit[]}
 */
export type RepoContext = { name: string; url: string; kind: string; default_branch: string };
export type PersonContext = {
  handle: string;
  name: string;
  pronouns: string;
  role: string;

  /** Title and one-line summary from the role's role.yaml; "" if not in the catalog. */
  role_title: string;
  role_summary: string;
  model: string;
};

export type RoleInfo = { name: string; title: string; summary: string };
export type HumanContext = { name: string };

export const PORTS = ["tracker", "knowledge", "vcs", "chat", "runtime", "avatars"] as const;
type Port = (typeof PORTS)[number];

export type CatalogContext = {
  team: { name: string; product: string };
  repos: { list: RepoContext[]; primary: RepoContext | null };
  people: { list: PersonContext[]; byRole: Record<string, PersonContext[]> };
  roles: (RoleInfo & { people: PersonContext[] })[];
  humans: { list: HumanContext[]; has: boolean; default_trust: boolean };
  integrations: { has: Record<Port, boolean>; adapter: Record<Port, string> };
  links: Record<string, string>;
  policies: { messages: { max_lines: number; always_link: boolean; omit: string[] } };
};

export type ContextExtras = {
  /** URL templates by name; merged over empty `issue`, `pr` and `doc`. */
  links?: Record<string, string>;

  /** Catalog roles; each gets a (possibly empty) `people.byRole` list and a `roles` entry. */
  roles?: RoleInfo[];
};

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
    repos: { list: repos, primary: repos.find((r) => r.kind === "primary") ?? null },
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
    },
  };
}
