import { err } from "./fake-state.js";
import type { ApiAttachment, ApiProject } from "@outstaff/integration.shared.itsaplan";
import type { FakeState, Route, StoredIssue } from "./types.js";

/** The REST routes of the tracker API, over the fake's state. */
export function fakeRoutes(state: FakeState): Route[] {
  const {
    key,
    teamRef,
    ref,
    columns,
    labels,
    assignees,
    issues,
    activity,
    attachments,
    log,
    isProject,
    issueBySeq,
    issueById,
    touch,
    create,
    column,
    page,
    nextLabelId,
  } = state;

  // A move to another column, logged as the status change the activity feed reports.
  const move = (issue: StoredIssue, columnId: number | undefined) => {
    if (columnId === undefined || columnId === issue.columnId) {
      return;
    }

    const from = column(issue.columnId)?.name;
    issue.columnId = columnId;
    log(issue, {
      kind: "history",
      action: "status",
      body: null,
      payload: { from: { value: from }, to: { value: column(columnId)?.name } },
    });
  };

  return [
    {
      method: "GET",
      path: "/projects/:p",
      handler: (r) =>
        isProject(r.params["p"]!)
          ? ({
              project: { id: 1, teamId: 1, teamName: "Acme", teamRef, key, ref, name: "Shop" },
              columns,
              labels,
              assignees,
            } satisfies ApiProject)
          : err(404, "project not found"),
    },
    {
      method: "POST",
      path: "/projects/:p/labels",
      handler: (r) => {
        const label = { id: nextLabelId(), projectId: 1, name: r.json.name as string };
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

        const b = r.json as Partial<StoredIssue>;
        move(issue, b.columnId);
        if (b.assigneeUserId !== undefined) {
          issue.assigneeUserId = b.assigneeUserId;
          log(issue, { kind: "history", action: "assignee", body: null, payload: {} });
        }

        if (b.parentId !== undefined) {
          issue.parentId = b.parentId;
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

        return {
          status: 201,
          body: { id: attachments.length, name: file.name } satisfies ApiAttachment,
        };
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
          .map((a): ApiAttachment => ({
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
  ];
}
