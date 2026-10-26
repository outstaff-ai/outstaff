import type { Doc, Member } from "@outstaff/core";
import type { KnowledgeSeed, TrackerSeed } from "@outstaff/core/contracts";
import { findRange, mdToDoc, type PmNode } from "../markdown.js";
import { API_ORIGIN, createStubFetch, type Route, type StubReply } from "./http-stub.js";

// A stateful stand-in for the parts of the Its a Plan REST API the adapters use, shaped after its OpenAPI document.
// The adapters talk to it over the injected fetch, so the contract kits run the real client code.

interface Column {
  id: number;
  projectId: number;
  name: string;
  stateType: string;
  position: number;
}

interface Issue {
  id: number;
  sequenceNumber: number;
  identifier: string;
  title: string;
  description: string;
  columnId: number;
  assigneeUserId: string | null;
  labelIds: number[];
  createdAt: string;
  updatedAt: string;
}

interface Activity {
  id: number;
  issueId: number;
  issueSequence: number;
  issueTitle: string;
  kind: "comment" | "history";
  replyToId: number | null;
  actorUserId: string;
  actorName: string;
  body: string | null;
  action: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface DocRow {
  id: number;
  parentId: number | null;
  title: string;
  metadata: Record<string, unknown>;
  version: number;
  content: string;
  contentJson: PmNode | null;
  createdAt: string;
  updatedAt: string;
}

interface DocComment {
  id: string;
  documentId: number;
  parentId: string | null;
  authorId: string;
  authorName: string;
  body: string;
  quote: string | null;
  from: number | null;
  to: number | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface FakeOptions {
  /** Column names; default is the Title Case set matching the canonical statuses. */
  columns?: { name: string; stateType: string }[];
  projectKey?: string;
  teamRef?: string;
}

const DEFAULT_COLUMNS = [
  { name: "Backlog", stateType: "backlog" },
  { name: "Ready", stateType: "unstarted" },
  { name: "In Progress", stateType: "started" },
  { name: "Review", stateType: "started" },
  { name: "Blocked", stateType: "started" },
  { name: "Done", stateType: "completed" },
  { name: "Canceled", stateType: "canceled" },
];

const err = (status: number, error: string, code?: string): StubReply => ({
  status,
  body: { error, ...(code ? { code } : {}) },
});

export function createItsaplanFake(opts: FakeOptions = {}) {
  const key = opts.projectKey ?? "SHOP";
  const ref = `${opts.teamRef ?? "acme"}.${key}`;
  let tick = 0;
  const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + ++tick * 1000).toISOString();
  const columns: Column[] = (opts.columns ?? DEFAULT_COLUMNS).map((c, i) => ({
    id: 10 + i,
    projectId: 1,
    position: i,
    ...c,
  }));

  const labels: { id: number; projectId: number; name: string }[] = [];
  const assignees = [
    { userId: "u-sam", name: "Sam Duarte", username: "sam", kind: "member" as const },
    { userId: "u-rio", name: "Rio Park", username: "rio", kind: "member" as const },
  ];

  const issues: Issue[] = [];
  const activity: Activity[] = [];
  let activityId = 100;
  let labelId = 500;
  let commentCounter = 0;
  const docs: DocRow[] = [];
  const docComments: DocComment[] = [];
  let docId = 0;

  const actor = assignees[0]!;
  const log = (
    issue: Issue,
    entry: Pick<Activity, "kind" | "action" | "body" | "payload"> & { replyToId?: number },
  ): Activity => {
    const row: Activity = {
      id: ++activityId,
      issueId: issue.id,
      issueSequence: issue.sequenceNumber,
      issueTitle: issue.title,
      replyToId: null,
      actorUserId: actor.userId,
      actorName: actor.name,
      createdAt: clock(),
      ...entry,
    };

    activity.push(row);
    return row;
  };

  const isProject = (p: string) => p === key || p === ref;
  const issueBySeq = (seq: string) => issues.find((i) => i.sequenceNumber === Number(seq));
  const attachments: { issueId: number; name: string; mimetype: string; data: Uint8Array }[] = [];
  const issueById = (id: string) => issues.find((i) => i.id === Number(id));
  const touch = (i: Issue) => void (i.updatedAt = clock());

  const create = (b: {
    title: string;
    description?: string;
    columnId: number;
    assigneeUserId?: string;
    labelIds?: number[];
  }): Issue => {
    const seq = issues.length + 1;
    const issue: Issue = {
      id: 1000 + seq,
      sequenceNumber: seq,
      identifier: `${key}-${seq}`,
      title: b.title,
      description: b.description ?? "",
      columnId: b.columnId,
      assigneeUserId: b.assigneeUserId ?? null,
      labelIds: b.labelIds ?? [],
      createdAt: clock(),
      updatedAt: clock(),
    };

    issues.push(issue);
    log(issue, { kind: "history", action: "created", body: null, payload: {} });
    return issue;
  };

  const column = (id: number) => columns.find((c) => c.id === id);

  const page = <T extends { id: number; createdAt: string }>(
    all: T[],
    query: URLSearchParams,
    newestFirst: boolean,
  ) => {
    const limit = Math.min(Number(query.get("limit") ?? 25), 100);
    const cursor = query.get("cursor")
      ? (JSON.parse(query.get("cursor")!) as { id: number })
      : null;

    let rows = all.toSorted((a, b) => (newestFirst ? b.id - a.id : a.id - b.id));
    if (cursor) {
      rows = rows.filter((r) => (newestFirst ? r.id < cursor.id : r.id > cursor.id));
    }

    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      ...(rows.length > limit && last ? { nextCursor: { ts: last.createdAt, id: last.id } } : {}),
    };
  };

  const docSummary = (d: DocRow) => {
    const { content: _c, contentJson: _j, ...rest } = d;
    return rest;
  };

  const docFull = (d: DocRow) => ({
    ...docSummary(d),
    content: d.content,
    contentJson: d.contentJson,
  });

  const doc = (id: string) => docs.find((d) => d.id === Number(id));

  const routes: Route[] = [
    {
      method: "GET",
      path: "/projects/:p",
      handler: (r) =>
        isProject(r.params["p"]!)
          ? {
              project: { id: 1, key, ref, name: "Shop" },
              columns,
              labels,
              assignees,
            }
          : err(404, "project not found"),
    },
    {
      method: "POST",
      path: "/projects/:p/labels",
      handler: (r) => {
        const label = { id: ++labelId, projectId: 1, name: r.json.name as string };
        labels.push(label);
        return { status: 201, body: label };
      },
    },
    {
      method: "GET",
      path: "/projects/:p/issues/search",
      handler: (r) => {
        const q = (r.query.get("q") ?? "").toLowerCase();
        const limit = Number(r.query.get("limit") ?? 50);
        return issues
          .filter((i) => `${i.title} ${i.description}`.toLowerCase().includes(q))
          .slice(0, limit)
          .map(({ description: _d, ...rest }) => rest);
      },
    },
    {
      method: "GET",
      path: "/projects/:p/issues/:seq",
      handler: (r) => {
        if (r.params["seq"] === "403") {
          return err(403, "You cannot read this issue.", "forbidden");
        }

        const issue = issueBySeq(r.params["seq"]!);
        return issue ?? err(404, "issue not found");
      },
    },
    {
      method: "GET",
      path: "/projects/:p/issues",
      handler: (r) => {
        const col = r.query.get("columnId");
        const who = r.query.get("assigneeUserId");
        const since = r.query.get("updatedFrom");
        return issues
          .filter((i) => (col ? i.columnId === Number(col) : true))
          .filter((i) => (who ? i.assigneeUserId === who : true))
          .filter((i) => (since ? i.updatedAt >= since : true))
          .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, Number(r.query.get("limit") ?? 50))
          .map(({ description: _d, ...rest }) => rest);
      },
    },
    {
      method: "POST",
      path: "/projects/:p/issues",
      handler: (r) => {
        if (!column(Number(r.json.columnId))) {
          return err(400, "unknown column");
        }

        return { status: 201, body: create(r.json) };
      },
    },
    {
      method: "GET",
      path: "/issues/:id",
      handler: (r) => issueById(r.params["id"]!) ?? err(404, "issue not found"),
    },
    {
      method: "PATCH",
      path: "/issues/:id",
      handler: (r) => {
        const issue = issueById(r.params["id"]!);
        if (!issue) {
          return err(404, "issue not found");
        }

        const b = r.json as Partial<Issue>;
        if (b.columnId !== undefined && b.columnId !== issue.columnId) {
          const from = column(issue.columnId)?.name;
          issue.columnId = b.columnId;
          log(issue, {
            kind: "history",
            action: "status",
            body: null,
            payload: { from: { value: from }, to: { value: column(b.columnId)?.name } },
          });
        }

        if (b.assigneeUserId !== undefined) {
          issue.assigneeUserId = b.assigneeUserId;
          log(issue, { kind: "history", action: "assignee", body: null, payload: {} });
        }

        if (b.labelIds) {
          issue.labelIds = b.labelIds;
        }

        touch(issue);
        return issue;
      },
    },
    {
      method: "POST",
      path: "/issues/:id/comments",
      handler: (r) => {
        const issue = issueById(r.params["id"]!);
        if (!issue) {
          return err(404, "issue not found");
        }

        touch(issue);
        return {
          status: 201,
          body: log(issue, {
            kind: "comment",
            action: null,
            body: r.json.body as string,
            payload: {},
          }),
        };
      },
    },
    {
      method: "POST",
      path: "/issues/:id/attachments",
      handler: async (r) => {
        const issue = issueById(r.params["id"]!);
        if (!issue) {
          return err(404, "issue not found");
        }

        const file = r.form?.get("file");
        if (!(file instanceof File)) {
          return err(400, "file is required", "validation");
        }

        touch(issue);
        attachments.push({
          issueId: issue.id,
          name: file.name,
          mimetype: file.type,
          data: new Uint8Array(await file.arrayBuffer()),
        });

        return { status: 201, body: { id: attachments.length, name: file.name } };
      },
    },
    {
      method: "GET",
      path: "/issues/:id/attachments",
      handler: (r) => {
        const issue = issueById(r.params["id"]!);
        if (!issue) {
          return err(404, "issue not found");
        }

        return attachments
          .filter((a) => a.issueId === issue.id)
          .map((a) => ({
            publicId: `pub-${attachments.indexOf(a) + 1}`,
            filename: a.name,
            mimeType: a.mimetype,
            size: a.data.byteLength,
          }));
      },
    },
    {
      method: "GET",
      path: "/attachments/:publicId/raw",
      handler: (r) => {
        const a = attachments[Number(r.params["publicId"]!.replace("pub-", "")) - 1];
        return a
          ? { buffer: a.data, headers: { "content-type": a.mimetype } }
          : err(404, "attachment not found");
      },
    },
    {
      method: "GET",
      path: "/issues/:id/feed",
      handler: (r) => {
        const issue = issueById(r.params["id"]!);
        if (!issue) {
          return err(404, "issue not found");
        }

        const filter = r.query.get("filter");
        const rows = activity
          .filter((a) => a.issueId === issue.id)
          .filter((a) => (filter === "comments" ? a.kind === "comment" : true));

        return page(rows, r.query, r.query.get("order") !== "asc");
      },
    },
    {
      method: "POST",
      path: "/issues/:id/links",
      handler: (r) => {
        const from = issueById(r.params["id"]!);
        const to = issueById(String(r.json.targetIssueId));
        return from && to
          ? { status: 201, body: { id: 1, kind: r.json.kind, direction: "outward", issue: to } }
          : err(404, "issue not found");
      },
    },
    {
      method: "GET",
      path: "/projects/:p/analytics/activity",
      handler: (r) => page(activity, r.query, true),
    },

    // --- documents
    {
      method: "GET",
      path: "/projects/:p/documents",
      handler: (r) => {
        const q = r.query.get("q")?.toLowerCase();
        return docs
          .filter((d) => (q ? `${d.title}\n${d.content}`.toLowerCase().includes(q) : true))
          .map(docSummary);
      },
    },
    {
      method: "POST",
      path: "/projects/:p/documents",
      handler: (r) => {
        const b = r.json as Partial<DocRow>;
        const row: DocRow = {
          id: ++docId,
          parentId: b.parentId ?? null,
          title: b.title ?? "Untitled",
          metadata: b.metadata ?? {},
          version: 1,
          content: b.content ?? "",
          contentJson: b.contentJson ?? null,
          createdAt: clock(),
          updatedAt: clock(),
        };

        docs.push(row);
        return { status: 201, body: docFull(row) };
      },
    },
    {
      method: "GET",
      path: "/projects/:p/documents/:id",
      handler: (r) => {
        if (r.params["id"] === "403") {
          return err(403, "You cannot read this document.", "forbidden");
        }

        const d = doc(r.params["id"]!);
        return d ? docFull(d) : err(404, "document not found");
      },
    },
    {
      method: "PATCH",
      path: "/projects/:p/documents/:id",
      handler: (r) => {
        const d = doc(r.params["id"]!);
        if (!d) {
          return err(404, "document not found");
        }

        const b = r.json as Partial<DocRow>;
        if (Number(b.version) !== d.version) {
          return err(409, "The page changed; read it again.", "version_conflict");
        }

        if (b.title !== undefined) {
          d.title = b.title;
        }

        if (b.content !== undefined) {
          d.content = b.content;
        }

        if (b.contentJson !== undefined) {
          d.contentJson = b.contentJson;
        }

        d.version += 1;
        d.updatedAt = clock();
        return docFull(d);
      },
    },
    {
      method: "GET",
      path: "/projects/:p/documents/:id/comments",
      handler: (r) => docComments.filter((c) => c.documentId === Number(r.params["id"])),
    },
    {
      method: "POST",
      path: "/projects/:p/documents/:id/comments",
      handler: (r) => {
        const d = doc(r.params["id"]!);
        if (!d) {
          return err(404, "document not found");
        }

        const b = r.json as {
          body: string;
          parentId?: string;
          quote?: string;
          from?: number;
          to?: number;
          version: number;
        };

        if (b.version !== d.version) {
          return err(409, "The page changed; read it again.", "version_conflict");
        }

        if (!b.parentId) {
          const range = d.contentJson && b.quote ? findRange(d.contentJson, b.quote) : undefined;
          if (!range || range[0] !== b.from || range[1] !== b.to) {
            return err(400, "The quote is not at those positions.");
          }
        } else if (!docComments.some((c) => c.id === b.parentId)) {
          return err(404, "comment not found");
        }

        const row: DocComment = {
          id: `c-${++commentCounter}`,
          documentId: d.id,
          parentId: b.parentId ?? null,
          authorId: actor.userId,
          authorName: actor.name,
          body: b.body,
          quote: b.quote ?? null,
          from: b.from ?? null,
          to: b.to ?? null,
          resolvedAt: null,
          createdAt: clock(),
        };

        docComments.push(row);
        return { status: 201, body: { id: row.id } };
      },
    },
    {
      method: "PATCH",
      path: "/projects/:p/documents/:id/comments/:cid",
      handler: (r) => {
        const c = docComments.find(
          (x) => x.id === r.params["cid"] && x.documentId === Number(r.params["id"]),
        );

        if (!c) {
          return err(404, "comment not found");
        }

        if (r.json.resolved) {
          c.resolvedAt = clock();
        }

        return { ok: true };
      },
    },
  ];

  const stub = createStubFetch(routes, API_ORIGIN);

  const trackerSeed: TrackerSeed = {
    async member(m) {
      const userId = `u-${assignees.length + 1}`;
      assignees.push({
        userId,
        name: m.name,
        username: m.name.toLowerCase(),
        kind: "member",
      });

      return { id: userId, name: m.name, kind: m.kind ?? "human" } satisfies Member;
    },
    forbiddenCall: () => Promise.reject(new Error("bound by the test")),
  };

  const knowledgeSeed: KnowledgeSeed = {
    async doc(d) {
      const mdDoc = mdToDoc(d.body);
      const row: DocRow = {
        id: ++docId,
        parentId: null,
        title: d.title,
        metadata: { path: d.path },
        version: 1,
        content: d.body,
        contentJson: mdDoc,
        createdAt: clock(),
        updatedAt: clock(),
      };

      docs.push(row);
      return {
        id: String(row.id),
        path: d.path,
        title: d.title,
        body: d.body,
        url: "",
        version: "1",
        updatedAt: row.updatedAt,
      } satisfies Doc;
    },
  };

  return {
    fetch: stub.fetch,
    calls: stub.calls,
    called: stub.called,
    state: { issues, docs, docComments, activity, columns, labels, assignees, attachments },
    trackerSeed,
    knowledgeSeed,
    project: { key, ref },
  };
}

export type ItsaplanFake = ReturnType<typeof createItsaplanFake>;
