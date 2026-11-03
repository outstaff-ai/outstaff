import { knownInitiative, withInitiative } from "./initiative-routes.js";
import { addLink, issueView, linkIndex, linkOf } from "./links.js";
import { assignIssue, commentIssue, issueById, moveIssue, page, touch } from "./model.js";
import { err } from "./store.js";
import type { ActorRoute, ItsaplanStore, StoredIssue } from "./types.js";

/** The fields a change sets as they are given; `initiativeId: null` takes the issue out of its initiative. */
function copied(b: Partial<StoredIssue>): Partial<StoredIssue> {
  const given = (["parentId", "title", "description", "labelIds"] as const).filter(
    (k) => b[k] !== undefined,
  );

  return {
    ...Object.fromEntries(given.map((k) => [k, b[k]])),
    ...(b.initiativeId === undefined
      ? {}
      : { initiativeId: b.initiativeId === null ? null : Number(b.initiativeId) }),
  };
}

/** Applies a `PATCH /issues/:id` body; moves and assignments land in the feed, title and description edits do not. */
function patchIssue(s: ItsaplanStore, issue: StoredIssue, actor: string, b: Partial<StoredIssue>) {
  if (b.columnId !== undefined) {
    moveIssue(s, issue, actor, b.columnId);
  }

  if (b.assigneeUserId !== undefined) {
    assignIssue(s, issue, actor, b.assigneeUserId);
  }

  Object.assign(issue, copied(b));
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
      handler: (r) => {
        const issue = issueById(s, r.params["id"]!);
        return issue ? issueView(s, issue) : missing;
      },
    },
    {
      method: "PATCH",
      path: "/issues/:id",
      handler: (r, actor) => {
        const issue = issueById(s, r.params["id"]!);
        if (!issue) {
          return missing;
        }

        return knownInitiative(s, r.json.initiativeId)
          ? withInitiative(s, patchIssue(s, issue, actor, r.json))
          : err(404, "initiative not found");
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

        const link = addLink(s, from, to, String(r.json.kind));
        return link ? { status: 201, body: linkOf(s, from, link) } : err(400, "unknown link kind");
      },
    },
    {
      method: "DELETE",
      path: "/issues/:id/links/:linkId",
      handler: (r) => {
        const issue = issueById(s, r.params["id"]!);
        const at = issue ? linkIndex(s, issue, Number(r.params["linkId"])) : -1;
        if (at < 0) {
          return err(404, "link not found");
        }

        s.links.splice(at, 1);
        return { status: 204 };
      },
    },
    {
      method: "GET",
      path: "/projects/:p/analytics/activity",
      handler: (r) => page(s.activity, r.query, true),
    },
  ];
}
