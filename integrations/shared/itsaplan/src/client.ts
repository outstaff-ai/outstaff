import { PortError, type AdapterContext, type Logger, type Member } from "@outstaff/core";
import { buildFetch } from "./fetch.js";
import { ItsaplanHttp } from "./http.js";
import { resolveConnection } from "./options.js";
import type {
  ApiAssignee,
  ApiProject,
  ClientDeps,
  Connection,
  ConnectionOptions,
  OptionalConnectionOptions,
} from "./types.js";

const SETUP_TTL_MS = 30_000;

/** First wait before asking for the workspace again after a failure; doubles up to the maximum. */
const WORKSPACE_RETRY_MS = 5_000;
const WORKSPACE_RETRY_MAX_MS = 300_000;

/** The typed client both Its a Plan adapters share: HTTP, the project's setup (columns, labels, members) and links. */
export class Itsaplan {
  private setup: { at: number; value: ApiProject } | undefined;

  /** The team's segment in web URLs (`teamRef` of the project); resolved on first use, never at start. */
  workspace: string | undefined;

  private retry = { at: 0, delayMs: WORKSPACE_RETRY_MS };
  private warned = false;

  constructor(
    readonly http: ItsaplanHttp,
    readonly conn: Connection,
    private readonly ctx: Pick<AdapterContext<unknown>, "team" | "now"> & { log?: Logger },
  ) {}

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
    this.workspace ||= value.project.teamRef || undefined;
    return value;
  }

  invalidate(): void {
    this.setup = undefined;
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
    return {
      id: a.userId,
      name: a.name,
      ...(username ? { username } : {}),
      kind: this.isAgent(a, username) ? "agent" : "human",
    };
  }

  /** An agent by its kind, or by a username or name that is one of the team's agents or people. */
  private isAgent(a: ApiAssignee, username: string | undefined): boolean {
    if (a.kind === "agent") {
      return true;
    }

    const known = new Set([
      ...this.conn.agents,
      ...(this.ctx.team?.people ?? []).map((p) => p.handle),
    ]);

    return (username !== undefined && known.has(username)) || known.has(a.name);
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

  /** Reads the workspace slug from the project setup; fails when the API is unreachable or names none. Used by `ost doctor`. */
  async loadWorkspace(): Promise<void> {
    const ref = (await this.http.request<ApiProject>("GET", this.projectPath)).project.teamRef;
    if (!ref) {
      throw new PortError(
        "invalid",
        `Its a Plan did not name the workspace of project ${this.conn.project}, so links cannot be built.`,
      );
    }

    this.workspace = ref;
  }

  /**
   * Resolves the workspace if it is not known yet, without ever failing: an unreachable API only delays it. After a
   * failure it is not asked again until a backoff (5 s, doubling to 5 min) has passed.
   */
  async ensureWorkspace(): Promise<void> {
    if (this.workspace !== undefined || this.ctx.now().getTime() < this.retry.at) {
      return;
    }

    try {
      await this.project(true);
      if (this.workspace === undefined) {
        throw new PortError("invalid", "The project names no workspace.");
      }

      this.retry = { at: 0, delayMs: WORKSPACE_RETRY_MS };
    } catch (error) {
      this.retry = {
        at: this.ctx.now().getTime() + this.retry.delayMs,
        delayMs: Math.min(this.retry.delayMs * 2, WORKSPACE_RETRY_MAX_MS),
      };

      this.ctx.log?.debug("could not resolve the Its a Plan workspace", {
        error: (error as Error).message,
      });
    }
  }

  issueUrl(key: string): string {
    return this.link(this.conn.issue_url, "{url}/{workspace}/issue/{key}", "{url}/{key}", { key });
  }

  docUrl(id: string): string {
    return this.link(
      this.conn.doc_url,
      "{url}/{workspace}/{project}/docs/{id}",
      "{url}/{project}/docs/{id}",
      { id },
    );
  }

  /**
   * Builds a link. While the workspace is unknown, a template that needs it gives way to `bare` (the shape without
   * the workspace), warns once, and starts resolving the workspace in the background.
   */
  private link(
    explicit: string | undefined,
    byDefault: string,
    bare: string,
    vars: Record<string, string>,
  ): string {
    const tpl = explicit ?? byDefault;
    if (this.workspace !== undefined || !tpl.includes("{workspace}")) {
      return this.template(tpl, vars);
    }

    if (!this.warned) {
      this.warned = true;
      this.ctx.log?.warn(
        "The Its a Plan workspace is not known yet, so links leave it out until the API answers.",
      );
    }

    void this.ensureWorkspace();
    return this.template(bare, vars);
  }

  /** The link to one issue comment: the `issue_comment_url` template, else the issue (no anchor is known). */
  issueCommentUrl(key: string, commentId: string): string {
    const tpl = this.conn.issue_comment_url;
    return tpl ? this.template(tpl, { key, commentId }) : this.issueUrl(key);
  }

  /** The link to one document comment; `commentId` may be the adapter's `<docId>:<id>` form. */
  docCommentUrl(id: string, commentId: string): string {
    const tpl = this.conn.doc_comment_url;
    return tpl
      ? this.template(tpl, { id, commentId: commentId.split(":").at(-1)! })
      : this.docUrl(id);
  }

  private template(tpl: string, vars: Record<string, string>): string {
    const all: Record<string, string> = {
      url: this.conn.url.replace(/\/+$/, ""),
      project: this.conn.project,
      ...(this.workspace === undefined ? {} : { workspace: this.workspace }),
      ...vars,
    };

    return tpl.replaceAll(/\{(\w+)\}/g, (m, k: string) =>
      all[k] === undefined ? m : k === "url" ? all[k] : encodeURIComponent(all[k]),
    );
  }
}

export async function createClient(
  ctx: AdapterContext<ConnectionOptions | OptionalConnectionOptions>,
  deps: ClientDeps = {},
): Promise<Itsaplan> {
  const conn = resolveConnection(ctx, ctx.options);
  const fetchImpl = await buildFetch(ctx.fetch, conn, deps);
  const api = new Itsaplan(
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

  return api;
}
