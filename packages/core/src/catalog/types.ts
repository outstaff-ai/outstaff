import type { z } from "zod";
import type { CATALOG_CODES } from "./codes.js";
import type { PORTS } from "./context.js";
import type { roleSchema } from "./role.js";

export type CatalogCode = (typeof CATALOG_CODES)[keyof typeof CATALOG_CODES];

export type CatalogIssue = {
  code: string;
  message: string;
  file: string;
  line: number;
  column: number;
};

export type Role = z.output<typeof roleSchema>;

export type CatalogDoc = { name: string; file: string; text: string };
export type CatalogRole = Role & { dir: string; skill: CatalogDoc };
export type Catalog = {
  /** From `<dir>/package.json`, or the `version` option. */
  version: string;
  dir: string;
  roles: Record<string, CatalogRole>;
  process: Record<string, CatalogDoc>;
  references: Record<string, CatalogDoc>;
  templates: Record<string, CatalogDoc>;
};

export type LoadCatalogOptions = { version?: string };

export type TemplatePos = { line: number; column: number };
export type TemplateNode =
  | { t: "text"; text: string }
  | { t: "var"; path: string; pos: TemplatePos }
  | {
      t: "if" | "unless";
      path: string;
      pos: TemplatePos;
      body: TemplateNode[];
      otherwise: TemplateNode[];
    }
  | { t: "each"; path: string; pos: TemplatePos; body: TemplateNode[] };

export type Template = { file: string; nodes: TemplateNode[] };
export type RenderOptions = { file?: string };

/**
 * The values a template can use. Every key below always exists, so a template
 * may test it with {{#if}}; an absent value is "" (or null for objects).
 *
 * One context for every catalog file; it never contains a person, because a role
 * reads the same for everyone who holds it. Who the agent is comes from data
 * at runtime.
 *
 *   team.name, team.product
 *   repos.many (true when the team has more than one repo),
 *   repos.list[] {name,url,kind,default_branch,checks[],conventions,instructions[]}, repos.primary (null when none),
 *                  repos.has_checks (true when any repo lists checks),
 *                  repos.has_conventions (true when any repo has conventions text)
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
 *   policies.tickets.many_prs (true when policies.tickets.prs_per_ticket is many)
 *   policies.design.canvas (true unless policies.design.canvas is switched off)
 */
export type RepoContext = {
  name: string;
  url: string;
  kind: string;
  default_branch: string;

  /** The repo's configured affected-check commands; empty when none. */
  checks: string[];

  /** The repo's free-text conventions from team.yaml; "" when none. */
  conventions: string;
  instructions: string[];
};

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

type Port = (typeof PORTS)[number];

export type CatalogContext = {
  team: { name: string; product: string };
  repos: {
    list: RepoContext[];
    primary: RepoContext | null;
    many: boolean;
    has_checks: boolean;
    has_conventions: boolean;
  };
  people: { list: PersonContext[]; byRole: Record<string, PersonContext[]> };
  roles: (RoleInfo & { people: PersonContext[] })[];
  humans: { list: HumanContext[]; has: boolean; default_trust: boolean };
  integrations: { has: Record<Port, boolean>; adapter: Record<Port, string> };
  links: Record<string, string>;
  policies: {
    messages: { max_lines: number; always_link: boolean; omit: string[] };
    tickets: { many_prs: boolean };
    design: { canvas: boolean };
  };
};

export type ContextExtras = {
  /** URL templates by name; merged over empty `issue`, `pr` and `doc`. */
  links?: Record<string, string>;

  /** Catalog roles; each gets a (possibly empty) `people.byRole` list and a `roles` entry. */
  roles?: RoleInfo[];
};
