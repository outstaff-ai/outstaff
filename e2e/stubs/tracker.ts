import type { Req, Route } from "./http.ts";

/** The parts of the Its a Plan REST API the tracker adapter uses: project setup, issues, comments and the activity feed. */

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

export interface Member {
  userId: string;
  name: string;
  username: string;
  kind: "member" | "agent";
}

export interface TrackerOptions {
  projectKey: string;
  teamRef: string;

  /** Status names; they match `workflow.statuses` of the team file. */
  columns: { name: string; stateType: string }[];
  members: Member[];

  /** API key to the userId it acts as. An unknown key is refused. */
  keys: Record<string, string>;

  /** The member the control endpoints act as. */
  human: string;
}

const err = (status: number, error: string, code?: string) => ({
  status,
  body: { error, ...(code ? { code } : {}) },
});

const page = <T extends { id: number; createdAt: string }>(
  all: T[],
  query: URLSearchParams,
  newestFirst: boolean,
) => {
  const limit = Math.min(Number(query.get("limit") ?? 25), 100);
  const cursor = query.get("cursor") ? (JSON.parse(query.get("cursor")!) as { id: number }) : null;

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

export function createTracker(opts: TrackerOptions) {
  const key = opts.projectKey;
  const ref = `${opts.teamRef}.${key}`;
  let tick = 0;
  // Strictly increasing, so the feed's order is the order things happened in.
  const clock = () => new Date(Date.now() + ++tick).toISOString();
  const columns: Column[] = opts.columns.map((c, i) => ({
    id: 10 + i,
    projectId: 1,
    position: i,
    ...c,
  }));

  const labels: { id: number; projectId: number; name: string }[] = [];
  const issues: Issue[] = [];

  /** Relations the agents made between tickets (`POST /issues/:id/links`). */
  const related: { from: string; to: string; kind: string }[] = [];
  const activity: Activity[] = [];

  /** Files attached to tickets, and the public ids a download was served for. */
  const attachments: { issueId: number; name: string; mimetype: string; data: Buffer }[] = [];
  const served: string[] = [];
  let activityId = 100;
  let labelId = 500;

  const member = (id: string) => opts.members.find((m) => m.userId === id)!;
  const column = (id: number) => columns.find((c) => c.id === id);
  const columnNamed = (name: string) =>
    columns.find((c) => c.name.toLowerCase() === name.toLowerCase());

  const isProject = (p: string) => p === key || p === ref;
  const issueBySeq = (seq: string) => issues.find((i) => i.sequenceNumber === Number(seq));
  const issueById = (id: string) => issues.find((i) => i.id === Number(id));
  const touch = (i: Issue) => void (i.updatedAt = clock());

  const log = (
    issue: Issue,
    actorId: string,
    entry: Pick<Activity, "kind" | "action" | "body" | "payload">,
  ): Activity => {
    const row: Activity = {
      id: ++activityId,
      issueId: issue.id,
      issueSequence: issue.sequenceNumber,
      issueTitle: issue.title,
      replyToId: null,
      actorUserId: actorId,
      actorName: member(actorId).name,
      createdAt: clock(),
      ...entry,
    };

    activity.push(row);
    return row;
  };

  const create = (
    actorId: string,
    b: { title: string; description?: string; columnId: number; assigneeUserId?: string },
  ): Issue => {
    const seq = issues.length + 1;
    const issue: Issue = {
      id: 1000 + seq,
      sequenceNumber: seq,
      identifier: `${key}-${seq}`,
      title: b.title,
      description: b.description ?? "",
      columnId: b.columnId,
      assigneeUserId: b.assigneeUserId ?? null,
      labelIds: [],
      createdAt: clock(),
      updatedAt: clock(),
    };

    issues.push(issue);
    log(issue, actorId, { kind: "history", action: "created", body: null, payload: {} });
    return issue;
  };

  const move = (issue: Issue, actorId: string, columnId: number) => {
    if (columnId === issue.columnId) {
      return;
    }

    const from = column(issue.columnId)?.name;
    issue.columnId = columnId;
    log(issue, actorId, {
      kind: "history",
      action: "status",
      body: null,
      payload: { from: { value: from }, to: { value: column(columnId)?.name } },
    });
  };

  const assign = (issue: Issue, actorId: string, userId: string | null) => {
    issue.assigneeUserId = userId;
    log(issue, actorId, { kind: "history", action: "assignee", body: null, payload: {} });
  };

  const actorOf = (r: Req): string | undefined => opts.keys[String(r.headers["x-api-key"] ?? "")];
  const denied = err(401, "Unknown API key.", "unauthorized");

  const summary = ({ description: _d, ...rest }: Issue) => rest;

  /** Every route needs a known key; the handler gets the member it acts as. */
  const as =
    (handler: (r: Req, who: string) => unknown): Route["handler"] =>
    (r) => {
      const who = actorOf(r);
      return who ? handler(r, who) : denied;
    };

  const base = "/tracker";
  const routes: Route[] = [
    {
      method: "GET",
      path: `${base}/projects/:p`,
      handler: as((r) =>
        isProject(r.params["p"]!)
          ? {
              project: { id: 1, key, ref, name: "Shop" },
              columns,
              labels,
              assignees: opts.members,
            }
          : err(404, "project not found"),
      ),
    },
    {
      method: "POST",
      path: `${base}/projects/:p/labels`,
      handler: as((r) => {
        const label = { id: ++labelId, projectId: 1, name: r.json.name as string };
        labels.push(label);
        return { status: 201, body: label };
      }),
    },
    {
      method: "GET",
      path: `${base}/projects/:p/issues/search`,
      handler: as((r) => {
        const q = (r.query.get("q") ?? "").toLowerCase();
        return issues
          .filter((i) => `${i.title} ${i.description}`.toLowerCase().includes(q))
          .slice(0, Number(r.query.get("limit") ?? 50))
          .map(summary);
      }),
    },
    {
      method: "GET",
      path: `${base}/projects/:p/issues/:seq`,
      handler: as((r) => issueBySeq(r.params["seq"]!) ?? err(404, "issue not found")),
    },
    {
      method: "GET",
      path: `${base}/projects/:p/issues`,
      handler: as((r) => {
        const col = r.query.get("columnId");
        const who = r.query.get("assigneeUserId");
        const since = r.query.get("updatedFrom");
        return issues
          .filter((i) => (col ? i.columnId === Number(col) : true))
          .filter((i) => (who ? i.assigneeUserId === who : true))
          .filter((i) => (since ? i.updatedAt >= since : true))
          .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, Number(r.query.get("limit") ?? 50))
          .map(summary);
      }),
    },
    {
      method: "POST",
      path: `${base}/projects/:p/issues`,
      handler: as((r, who) =>
        column(Number(r.json.columnId))
          ? { status: 201, body: create(who, r.json) }
          : err(400, "unknown column"),
      ),
    },
    {
      method: "GET",
      path: `${base}/issues/:id`,
      handler: as((r) => issueById(r.params["id"]!) ?? err(404, "issue not found")),
    },
    {
      method: "PATCH",
      path: `${base}/issues/:id`,
      handler: as((r, who) => {
        const issue = issueById(r.params["id"]!);
        if (!issue) {
          return err(404, "issue not found");
        }

        const b = r.json as Partial<Issue>;
        if (b.columnId !== undefined) {
          move(issue, who, b.columnId);
        }

        if (b.assigneeUserId !== undefined) {
          assign(issue, who, b.assigneeUserId);
        }

        if (b.labelIds) {
          issue.labelIds = b.labelIds;
        }

        touch(issue);
        return issue;
      }),
    },
    {
      method: "POST",
      path: `${base}/issues/:id/comments`,
      handler: as((r, who) => {
        const issue = issueById(r.params["id"]!);
        if (!issue) {
          return err(404, "issue not found");
        }

        touch(issue);
        return {
          status: 201,
          body: log(issue, who, { kind: "comment", action: null, body: r.json.body, payload: {} }),
        };
      }),
    },
    {
      method: "POST",
      path: `${base}/issues/:id/attachments`,
      handler: as(async (r) => {
        const issue = issueById(r.params["id"]!);
        if (!issue) {
          return err(404, "issue not found");
        }

        const form = await new Response(new Uint8Array(r.raw), {
          headers: { "content-type": String(r.headers["content-type"] ?? "") },
        })
          .formData()
          .catch(() => undefined);

        const file = form?.get("file");
        if (!(file instanceof File)) {
          return err(400, "file is required");
        }

        attachments.push({
          issueId: issue.id,
          name: file.name,
          mimetype: file.type,
          data: Buffer.from(await file.arrayBuffer()),
        });

        touch(issue);
        return {
          status: 201,
          body: { publicId: `pub-${attachments.length}`, filename: file.name },
        };
      }),
    },
    {
      method: "GET",
      path: `${base}/issues/:id/attachments`,
      handler: as((r) => {
        const issue = issueById(r.params["id"]!);
        if (!issue) {
          return err(404, "issue not found");
        }

        return attachments
          .map((a, i) => ({ a, publicId: `pub-${i + 1}` }))
          .filter(({ a }) => a.issueId === issue.id)
          .map(({ a, publicId }) => ({
            publicId,
            filename: a.name,
            mimeType: a.mimetype,
            size: a.data.length,
          }));
      }),
    },
    {
      method: "GET",
      path: `${base}/attachments/:publicId/raw`,
      handler: as((r) => {
        const a = attachments[Number(r.params["publicId"]!.replace("pub-", "")) - 1];
        if (!a) {
          return err(404, "attachment not found");
        }

        served.push(r.params["publicId"]!);
        return { buffer: a.data, headers: { "content-type": a.mimetype } };
      }),
    },
    {
      method: "GET",
      path: `${base}/issues/:id/feed`,
      handler: as((r) => {
        const issue = issueById(r.params["id"]!);
        if (!issue) {
          return err(404, "issue not found");
        }

        const filter = r.query.get("filter");
        const rows = activity
          .filter((a) => a.issueId === issue.id)
          .filter((a) => (filter === "comments" ? a.kind === "comment" : true));

        return page(rows, r.query, r.query.get("order") !== "asc");
      }),
    },
    {
      method: "POST",
      path: `${base}/issues/:id/links`,
      handler: as((r) => {
        const from = issueById(r.params["id"]!);
        const to = issueById(String(r.json.targetIssueId));
        if (!from || !to) {
          return err(404, "issue not found");
        }

        related.push({ from: from.identifier, to: to.identifier, kind: String(r.json.kind) });
        return { status: 201, body: { id: 1, kind: r.json.kind, direction: "outward", issue: to } };
      }),
    },
    {
      method: "GET",
      path: `${base}/projects/:p/analytics/activity`,
      handler: as((r) => page(activity, r.query, true)),
    },
  ];

  const human = opts.members.find((m) => m.username === opts.human)!.userId;
  const nameOf = (id: string | null) => (id ? member(id).username : null);
  return {
    routes,

    /** A person creates a ticket in a column (by status name). */
    /** With `assignee`, the ticket is created already assigned: one `created` item, no `assignee` item. */
    createTicket(title: string, description: string, status: string, assignee?: string) {
      const col = columnNamed(status);
      if (!col) {
        throw new Error(`No column ${status}.`);
      }

      const who =
        assignee === undefined ? undefined : opts.members.find((m) => m.username === assignee);

      if (assignee !== undefined && !who) {
        throw new Error(`No member ${assignee}.`);
      }

      return create(human, {
        title,
        description,
        columnId: col.id,
        ...(who ? { assigneeUserId: who.userId } : {}),
      }).identifier;
    },

    assignTicket(keyName: string, username: string) {
      const issue = issues.find((i) => i.identifier === keyName);
      const who = opts.members.find((m) => m.username === username);
      if (!issue || !who) {
        throw new Error(`Cannot assign ${keyName} to ${username}.`);
      }

      assign(issue, human, who.userId);
      touch(issue);
    },

    /** Public ids of the attachments the agents downloaded. */
    served: () => served,

    state() {
      return issues.map((i) => ({
        key: i.identifier,
        title: i.title,
        description: i.description,
        status: column(i.columnId)?.name,
        assignee: nameOf(i.assigneeUserId),
        links: related.filter((l) => l.from === i.identifier),
        attachments: attachments
          .filter((a) => a.issueId === i.id)
          .map((a) => ({
            name: a.name,
            mimetype: a.mimetype,
            size: a.data.length,
            base64: a.data.toString("base64"),
          })),
        comments: activity
          .filter((a) => a.issueId === i.id && a.kind === "comment")
          .map((a) => ({ author: nameOf(a.actorUserId), body: a.body })),
        moves: activity
          .filter((a) => a.issueId === i.id && a.action === "status")
          .map((a) => ({
            by: nameOf(a.actorUserId),
            from: (a.payload["from"] as { value?: string } | undefined)?.value,
            to: (a.payload["to"] as { value?: string } | undefined)?.value,
          })),
      }));
    },
  };
}
