import { assignIssue, commentIssue, issueById, moveIssue, page, touch } from "./model.js";
import { err } from "./store.js";
import type { ActorRoute, ItsaplanStore, StoredIssue } from "./types.js";

/** Applies a `PATCH /issues/:id` body; moves and assignments land in the feed. */
function patchIssue(s: ItsaplanStore, issue: StoredIssue, actor: string, b: Partial<StoredIssue>) {
  if (b.columnId !== undefined) {
    moveIssue(s, issue, actor, b.columnId);
  }

  if (b.assigneeUserId !== undefined) {
    assignIssue(s, issue, actor, b.assigneeUserId);
  }

  if (b.parentId !== undefined) {
    issue.parentId = b.parentId;
  }

  if (b.labelIds) {
    issue.labelIds = b.labelIds;
  }

  touch(s, issue);
  return issue;
}

/** One issue: read, change, comment, its feed and links; and the project's activity. */
export function issueRoutes(s: ItsaplanStore): ActorRoute[] {
  const missing = err(404, "issue not found");
  return [
    {
      method: "GET",
      path: "/issues/:id",
      handler: (r) => issueById(s, r.params["id"]!) ?? missing,
    },
    {
      method: "PATCH",
      path: "/issues/:id",
      handler: (r, actor) => {
        const issue = issueById(s, r.params["id"]!);
        return issue ? patchIssue(s, issue, actor, r.json) : missing;
      },
    },
    {
      method: "POST",
      path: "/issues/:id/comments",
      handler: (r, actor) => {
        const issue = issueById(s, r.params["id"]!);
        return issue
          ? { status: 201, body: commentIssue(s, issue, actor, r.json.body as string) }
          : missing;
      },
    },
    {
      method: "GET",
      path: "/issues/:id/feed",
      handler: (r) => {
        const issue = issueById(s, r.params["id"]!);
        if (!issue) {
          return missing;
        }

        const comments = r.query.get("filter") === "comments";
        const rows = s.activity
          .filter((a) => a.issueId === issue.id)
          .filter((a) => (comments ? a.kind === "comment" : true));

        return page(rows, r.query, r.query.get("order") !== "asc");
      },
    },
    {
      method: "POST",
      path: "/issues/:id/links",
      handler: (r) => {
        const from = issueById(s, r.params["id"]!);
        const to = issueById(s, String(r.json.targetIssueId));
        if (!from || !to) {
          return missing;
        }

        s.links.push({ from: from.identifier, to: to.identifier, kind: String(r.json.kind) });
        return { status: 201, body: { id: 1, kind: r.json.kind, direction: "outward", issue: to } };
      },
    },
    {
      method: "GET",
      path: "/projects/:p/analytics/activity",
      handler: (r) => page(s.activity, r.query, true),
    },
  ];
}
