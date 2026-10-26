import {
  PortError,
  type AdapterContext,
  type CanonicalStatus,
  type Comment,
  type EventPage,
  type NewIssue,
  type Tracker,
  type TrackerEvent,
} from "@outstaff/core";
import { createClient, type Itsaplan } from "./client.js";
import { readEvents } from "./events.js";
import { issueHelpers } from "./issues.js";
import type { ApiAttachment, ApiFeedItem, ApiIssue, ClientDeps, TrackerOptions } from "./types.js";

export function createItsaplanTracker(
  ctx: AdapterContext<TrackerOptions>,
  deps: ClientDeps = {},
): Promise<Tracker> {
  return createClient(ctx, deps).then((api) => buildTracker(api));
}

function buildTracker(api: Itsaplan): Tracker {
  const { toIssue, fetchIssue, labelIds, hydrate, patch, commentFeed, actor } = issueHelpers(api);

  return {
    links: {
      issue: (key) => api.issueUrl(key),
      comment: (key, id) => api.issueCommentUrl(key, id),
    },

    async getIssue(key) {
      return toIssue(await fetchIssue(key), await api.project());
    },

    async listIssues(filter) {
      const setup = await api.project();
      const items = await api.http.request<ApiIssue[]>("GET", `${api.projectPath}/issues`, {
        query: {
          columnId: filter.status ? api.column(setup, filter.status).id : undefined,
          assigneeUserId: filter.assignee ? api.resolveMemberId(setup, filter.assignee) : undefined,
          updatedFrom: filter.updatedSince,
          limit: filter.limit,
        },
      });

      return hydrate(items, setup);
    },

    async search(query, limit) {
      const items = await api.http.request<ApiIssue[]>("GET", `${api.projectPath}/issues/search`, {
        query: { q: query, limit },
      });

      return hydrate(items, await api.project());
    },

    async createIssue(issue: NewIssue) {
      const setup = await api.project();
      const body: Record<string, unknown> = {
        title: issue.title,
        description: issue.body,
        columnId: api.column(setup, issue.status ?? "backlog").id,
      };

      if (issue.assignee) {
        body["assigneeUserId"] = api.resolveMemberId(setup, issue.assignee);
      }

      if (issue.parent) {
        body["parentId"] = (await fetchIssue(issue.parent)).id;
      }

      if (issue.labels?.length) {
        body["labelIds"] = await labelIds(issue.labels, true);
      }

      const created = await api.http.request<ApiIssue>("POST", `${api.projectPath}/issues`, {
        body,
      });

      return toIssue(created, await api.project());
    },

    async transition(key, to: CanonicalStatus) {
      const setup = await api.project();
      return patch(key, { columnId: api.column(setup, to).id });
    },

    async assign(key, memberId) {
      const setup = await api.project();
      return patch(key, {
        assigneeUserId: memberId === null ? null : api.resolveMemberId(setup, memberId),
      });
    },

    async comment(key, body) {
      await api.ensureWorkspace();
      const issue = await fetchIssue(key);
      const made = await api.http.request<ApiFeedItem>("POST", `/issues/${issue.id}/comments`, {
        body: { body },
      });

      return { id: String(made.id), url: api.issueCommentUrl(issue.identifier, String(made.id)) };
    },

    async listComments(key): Promise<Comment[]> {
      const issue = await fetchIssue(key);
      const setup = await api.project();
      const items = await commentFeed(issue.id);
      return items
        .filter((i) => i.kind === "comment")
        .toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id)
        .map((i) => ({
          id: String(i.id),
          author: actor(setup, i),
          body: i.body ?? "",
          url: api.issueCommentUrl(issue.identifier, String(i.id)),
          at: i.createdAt,
        }));
    },

    async setLabels(key, add, remove) {
      const issue = await fetchIssue(key);
      const drop = new Set(await labelIds(remove, false));
      const extra = await labelIds(add, true);
      const next = [
        ...new Set([...(issue.labelIds ?? []).filter((id) => !drop.has(id)), ...extra]),
      ];

      const updated = await api.http.request<ApiIssue>("PATCH", `/issues/${issue.id}`, {
        body: { labelIds: next },
      });

      return toIssue(updated, await api.project());
    },

    async link(key, otherKey, relation) {
      const [from, to] = [await fetchIssue(key), await fetchIssue(otherKey)];
      await api.http.request("POST", `/issues/${from.id}/links`, {
        body: { targetIssueId: to.id, kind: relation },
      });
    },

    async setParent(key, parentKey) {
      const [child, parent] = [await fetchIssue(key), await fetchIssue(parentKey)];
      const updated = await api.http.request<ApiIssue>("PATCH", `/issues/${child.id}`, {
        body: { parentId: parent.id },
      });

      // An API that ignores the field answers with the issue unchanged: say so, so the caller relates them instead.
      if (updated.parentId !== parent.id) {
        throw new PortError("unsupported", "The tracker did not set the parent.");
      }

      return toIssue(updated, await api.project());
    },

    async attach(key, file) {
      const issue = await fetchIssue(key);
      const form = new FormData();
      form.set("file", new Blob([file.data.slice()], { type: file.mimetype }), file.name);
      await api.http.request("POST", `/issues/${issue.id}/attachments`, { form });
    },

    async attachments(key) {
      const issue = await fetchIssue(key);
      const res = await api.http.request<ApiAttachment[] | { items: ApiAttachment[] }>(
        "GET",
        `/issues/${issue.id}/attachments`,
      );

      return (Array.isArray(res) ? res : res.items).flatMap((a) => {
        const id = a.publicId ?? (a.id === undefined ? undefined : String(a.id));
        return id
          ? [
              {
                id,
                name: a.filename ?? a.name ?? id,
                mimetype: a.mimeType ?? a.contentType ?? "application/octet-stream",
                size: a.size ?? 0,
              },
            ]
          : [];
      });
    },

    async download(attachment) {
      return api.http.bytes(`/attachments/${encodeURIComponent(attachment.id)}/raw`);
    },

    async members() {
      return (await api.project(true)).assignees.map((a) => api.toMember(a));
    },

    async events(cursor): Promise<EventPage<TrackerEvent>> {
      return readEvents(api, actor, cursor);
    },
  };
}
