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
 *   people.list[] {handle,name,pronouns,role,model}, people.byRole.<role>[]
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
  model: string;
};

export const PORTS = ["tracker", "knowledge", "vcs", "chat", "runtime", "avatars", "mail"] as const;
type Port = (typeof PORTS)[number];

export type CatalogContext = {
  team: { name: string; product: string };
  repos: { list: RepoContext[]; primary: RepoContext | null };
  people: { list: PersonContext[]; byRole: Record<string, PersonContext[]> };
  integrations: { has: Record<Port, boolean>; adapter: Record<Port, string> };
  links: Record<string, string>;
  policies: { messages: { max_lines: number; always_link: boolean; omit: string[] } };
};

export type ContextExtras = {
  /** URL templates by name; merged over empty `issue`, `pr` and `doc`. */
  links?: Record<string, string>;

  /** Catalog role ids; each gets a (possibly empty) `people.byRole` list. */
  roles?: string[];
};

const DEFAULT_OMIT = ["ci", "mergeability", "hashes"];

const toPerson = (p: TeamConfig["people"][number]): PersonContext => ({
  handle: p.handle,
  name: p.name,
  pronouns: p.pronouns ?? "",
  role: p.role,
  model: p.model ?? "",
});

export function buildContext(team: TeamConfig, extras: ContextExtras = {}): CatalogContext {
  const list = team.people.map((p) => toPerson(p));
  const byRole: Record<string, PersonContext[]> = {};
  for (const role of extras.roles ?? []) {
    byRole[role] = [];
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
