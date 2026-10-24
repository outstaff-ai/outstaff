import { readFileSync } from "node:fs";
import { rootCertificates } from "node:tls";
import {
  PortError,
  type AdapterContext,
  type CanonicalStatus,
  type Member,
  type StatusMap,
} from "@outstaff/core";
import { ItsaplanHttp } from "./http.js";
import {
  resolveConnection,
  type Connection,
  type KnowledgeOptions,
  type TrackerOptions,
} from "./options.js";

export interface ApiColumn {
  id: number;
  name: string;
  stateType: string;
  position?: number;
}

export interface ApiLabel {
  id: number;
  name: string;
}

export interface ApiAssignee {
  userId: string;
  name: string;
  username?: string | null;
  kind?: "member" | "agent";
}

export interface ApiProject {
  project: { id: number; key: string; ref: string; name: string };
  columns: ApiColumn[];
  labels: ApiLabel[];
  assignees: ApiAssignee[];
}

export interface ClientDeps {
  readFile?: (path: string) => string;

  /** Builds a fetch that trusts the given PEM text; the default uses an undici Agent. */
  tlsFetch?: (ca: string) => Promise<typeof fetch>;
}

const SETUP_TTL_MS = 30_000;

/** Default status names, Title Case; `team.workflow.statuses` overrides them. */
const DEFAULT_NAMES: Record<CanonicalStatus, string> = {
  backlog: "Backlog",
  ready: "Ready",
  active: "Active",
  review: "Review",
  blocked: "Blocked",
  done: "Done",
  canceled: "Canceled",
};

/** Used when the project has no column with the mapped name: the first column of this kind. */
const STATE_FOR: Record<CanonicalStatus, string[]> = {
  backlog: ["backlog", "unstarted"],
  ready: ["unstarted", "backlog"],
  active: ["started"],
  review: ["started"],
  blocked: ["started"],
  done: ["completed"],
  canceled: ["canceled"],
};

const CANONICAL_FOR_STATE: Record<string, CanonicalStatus> = {
  backlog: "backlog",
  unstarted: "ready",
  started: "active",
  completed: "done",
  canceled: "canceled",
};

async function undiciFetch(ca: string): Promise<typeof fetch> {
  const { Agent, fetch: f } = await import("undici");
  const agent = new Agent({ connect: { ca: [...rootCertificates, ca] } });
  return ((input: string | URL, init?: RequestInit) =>
    f(input, { ...init, dispatcher: agent } as never)) as unknown as typeof fetch;
}

export async function buildFetch(
  base: typeof fetch,
  conn: Connection,
  deps: ClientDeps = {},
): Promise<typeof fetch> {
  if (!conn.ca_file) {
    return base;
  }

  let pem: string;
  try {
    pem = (deps.readFile ?? ((p) => readFileSync(p, "utf8")))(conn.ca_file);
  } catch (cause) {
    throw new PortError("invalid", `Cannot read ca_file ${conn.ca_file}.`, { cause });
  }

  return (deps.tlsFetch ?? undiciFetch)(pem);
}

/** The typed client both adapters share: HTTP, the project's setup (columns, labels, members) and links. */
export class Itsaplan {
  private setup: { at: number; value: ApiProject } | undefined;
  readonly statusMap: StatusMap;

  constructor(
    readonly http: ItsaplanHttp,
    readonly conn: Connection,
    private readonly ctx: Pick<AdapterContext<unknown>, "team" | "now">,
  ) {
    const configured = ctx.team?.workflow?.statuses ?? {};
    this.statusMap = { ...DEFAULT_NAMES, ...configured };
  }

  get projectPath(): string {
    return `/projects/${encodeURIComponent(this.conn.project)}`;
  }

  async project(refresh = false): Promise<ApiProject> {
    const now = this.ctx.now().getTime();
    if (!refresh && this.setup && now - this.setup.at < SETUP_TTL_MS) {
      return this.setup.value;
    }

    const value = await this.http.request<ApiProject>("GET", this.projectPath);
    this.setup = { at: now, value };
    return value;
  }

  invalidate(): void {
    this.setup = undefined;
  }

  /** The column for a canonical status: the mapped name, else the first column of the matching kind. */
  column(setup: ApiProject, status: CanonicalStatus): ApiColumn {
    const name = (this.statusMap[status] ?? DEFAULT_NAMES[status]).toLowerCase();
    const byName = setup.columns.find((c) => c.name.toLowerCase() === name);
    if (byName) {
      return byName;
    }

    for (const kind of STATE_FOR[status]) {
      const byKind = setup.columns
        .filter((c) => c.stateType === kind)
        .toSorted((a, b) => (a.position ?? 0) - (b.position ?? 0))[0];

      if (byKind) {
        return byKind;
      }
    }

    throw new PortError(
      "invalid",
      `The project has no column for "${status}" (looked for "${this.statusMap[status]}").`,
    );
  }

  status(setup: ApiProject, columnId: number): { name: string; canonical?: CanonicalStatus } {
    const col = setup.columns.find((c) => c.id === columnId);
    if (!col) {
      return { name: String(columnId) };
    }

    const lower = col.name.toLowerCase();
    const named = (Object.keys(this.statusMap) as CanonicalStatus[]).find(
      (s) => this.statusMap[s]?.toLowerCase() === lower,
    );

    const canonical = named ?? CANONICAL_FOR_STATE[col.stateType];
    return canonical ? { name: col.name, canonical } : { name: col.name };
  }

  member(
    setup: ApiProject,
    userId: string | null | undefined,
    fallbackName?: string | null,
  ): Member {
    const a = setup.assignees.find((x) => x.userId === userId);
    if (a) {
      return this.toMember(a);
    }

    return { id: userId ?? "unknown", name: fallbackName ?? userId ?? "unknown", kind: "human" };
  }

  toMember(a: ApiAssignee): Member {
    const username = a.username ?? undefined;
    const known = new Set([
      ...this.conn.agents,
      ...(this.ctx.team?.people ?? []).map((p) => p.handle),
    ]);

    const isAgent =
      a.kind === "agent" || (username !== undefined && known.has(username)) || known.has(a.name);

    return {
      id: a.userId,
      name: a.name,
      ...(username ? { username } : {}),
      kind: isAgent ? "agent" : "human",
    };
  }

  /** A member id from an id, a username or a team handle. */
  resolveMemberId(setup: ApiProject, ref: string): string {
    const lower = ref.toLowerCase();
    const hit =
      setup.assignees.find((a) => a.userId === ref) ??
      setup.assignees.find((a) => a.username?.toLowerCase() === lower) ??
      setup.assignees.find((a) => a.name.toLowerCase() === lower);

    if (!hit) {
      throw new PortError("not_found", `"${ref}" is not a member of ${this.conn.project}.`);
    }

    return hit.userId;
  }

  issueUrl(key: string): string {
    return this.template(this.conn.issue_url ?? "{url}/{key}", { key });
  }

  docUrl(id: string): string {
    return this.template(this.conn.doc_url ?? "{url}/{project}/docs/{id}", { id });
  }

  private template(tpl: string, vars: Record<string, string>): string {
    const all: Record<string, string> = {
      url: this.conn.url.replace(/\/+$/, ""),
      project: this.conn.project,
      ...vars,
    };

    return tpl.replaceAll(/\{(\w+)\}/g, (m, k: string) =>
      all[k] === undefined ? m : k === "url" ? all[k] : encodeURIComponent(all[k]),
    );
  }
}

export async function createClient(
  ctx: AdapterContext<TrackerOptions | KnowledgeOptions>,
  deps: ClientDeps = {},
): Promise<Itsaplan> {
  const conn = resolveConnection(ctx, ctx.options);
  const fetchImpl = await buildFetch(ctx.fetch, conn, deps);
  return new Itsaplan(
    new ItsaplanHttp({
      fetch: fetchImpl,
      apiUrl: conn.api_url,
      webUrl: conn.url,
      apiKey: ctx.secrets.require("ITSAPLAN_API_KEY"),
      log: ctx.log,
    }),
    conn,
    ctx,
  );
}
