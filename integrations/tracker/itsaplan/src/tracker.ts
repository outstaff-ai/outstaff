import {
  mentionData,
  PortError,
  type AdapterContext,
  type CanonicalStatus,
  type Comment,
  type EventPage,
  type Issue,
  type Member,
  type NewIssue,
  type Tracker,
  type TrackerEvent,
} from "@outstaff/core";
import { createClient, type ApiProject, type ClientDeps, type Itsaplan } from "./client.js";
import { OVERLAP_MS, parseCursor } from "./cursor.js";
import type { TrackerOptions } from "./options.js";

interface ApiIssue {
  id: number;
  sequenceNumber: number;
  identifier: string;
  title: string;
  description?: string | null;
  columnId: number;
  assigneeUserId?: string | null;
  labelIds?: number[];
  parentId?: number | null;
  updatedAt: string;
}

/** The API names these fields in more than one way across versions; the first present one wins. */
interface ApiAttachment {
  publicId?: string;
  id?: string | number;
  filename?: string;
  name?: string;
  mimeType?: string;
  contentType?: string;
  size?: number;
}

interface ApiFeedItem {
  id: number;
  kind: string;
  replyToId?: number | null;
  actorUserId?: string | null;
  actorName?: string | null;
  body?: string | null;
  createdAt: string;
}

interface ApiActivityItem extends ApiFeedItem {
  issueId: number;
  issueSequence: number;
  issueTitle?: string;
  action?: string | null;
  payload?: { from?: { value?: string }; to?: { value?: string }; subject?: { value?: string } };
}

interface Page<T> {
  items: T[];
  nextCursor?: { ts: string; id: number } | null;
}

const KEY = /^(?:([A-Za-z0-9_]+)-)?(\d+)$/;
const HYDRATE_CONCURRENCY = 5;
const FEED_PAGE = 100;
const EVENT_PAGES = 20;

export function createItsaplanTracker(
  ctx: AdapterContext<TrackerOptions>,
  deps: ClientDeps = {},
): Promise<Tracker> {
  return createClient(ctx, deps).then((api) => buildTracker(api));
}

function buildTracker(api: Itsaplan): Tracker {
  const toIssue = (raw: ApiIssue, setup: ApiProject): Issue => {
    const assignee = raw.assigneeUserId ? api.member(setup, raw.assigneeUserId) : undefined;
    return {
      key: raw.identifier,
      id: String(raw.id),
      title: raw.title,
      body: raw.description ?? "",
      status: api.status(setup, raw.columnId),
      ...(assignee ? { assignee } : {}),
      labels: (raw.labelIds ?? [])
        .map((id) => setup.labels.find((l) => l.id === id)?.name)
        .filter((n): n is string => n !== undefined),
      url: api.issueUrl(raw.identifier),
      updatedAt: raw.updatedAt,
    };
  };

  const fetchIssue = async (key: string): Promise<ApiIssue> => {
    const m = KEY.exec(key.trim());
    if (!m) {
      throw new PortError("invalid", `"${key}" is not an issue key (expected KEY-12).`);
    }

    const setup = await api.project();
    if (m[1] && m[1].toLowerCase() !== setup.project.key.toLowerCase()) {
      throw new PortError("not_found", `Issue ${key} is not in project ${setup.project.key}.`);
    }

    return api.http.request<ApiIssue>("GET", `${api.projectPath}/issues/${m[2]}`);
  };

  const labelIds = async (names: string[], create: boolean): Promise<number[]> => {
    let setup = await api.project();
    const ids: number[] = [];
    for (const name of names) {
      let label = setup.labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
      if (!label && create) {
        const made = await api.http.request<{ id: number; name: string }>(
          "POST",
          `${api.projectPath}/labels`,
          { body: { name } },
        );

        api.invalidate();
        setup = await api.project();
        label = made;
      }

      if (label) {
        ids.push(label.id);
      }
    }

    return [...new Set(ids)];
  };

  // Lists carry no description, so each issue is read in full (a few at a time).
  const hydrate = async (items: ApiIssue[], setup: ApiProject): Promise<Issue[]> => {
    const out: Issue[] = [];
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        const item = items[i]!;
        out[i] = toIssue(await api.http.request<ApiIssue>("GET", `/issues/${item.id}`), setup);
      }
    };

    await Promise.all(Array.from({ length: Math.min(HYDRATE_CONCURRENCY, items.length) }, worker));
    return out;
  };

  const patch = async (key: string, body: Record<string, unknown>): Promise<Issue> => {
    const issue = await fetchIssue(key);
    const updated = await api.http.request<ApiIssue>("PATCH", `/issues/${issue.id}`, { body });
    return toIssue(updated, await api.project());
  };

  const commentFeed = async (issueId: number): Promise<ApiFeedItem[]> => {
    const items: ApiFeedItem[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const res = await api.http.request<Page<ApiFeedItem>>("GET", `/issues/${issueId}/feed`, {
        query: { limit: FEED_PAGE, order: "asc", cursor, filter: "comments" },
      });

      items.push(...res.items);
      if (!res.nextCursor || res.items.length === 0) {
        break;
      }

      cursor = JSON.stringify(res.nextCursor);
    }

    return items;
  };

  const actor = (setup: ApiProject, item: ApiFeedItem): Member =>
    api.member(setup, item.actorUserId, item.actorName);

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
      const after = parseCursor(cursor);
      const setup = await api.project();
      const read: ApiActivityItem[] = [];
      let next: string | undefined;
      // Activity ids are identifiers only; progress is tracked by createdAt.
      // The feed is newest first: page back until a page reaches older than the overlap window.
      // Without a usable position the caller just wants to know where "now" is, plus the ids inside the overlap so they are not handed back later.
      let floor = (after?.since ?? Number.NaN) - OVERLAP_MS;
      for (let page = 0; page < EVENT_PAGES; page++) {
        const res = await api.http.request<Page<ApiActivityItem>>(
          "GET",
          `${api.projectPath}/analytics/activity`,
          { query: { limit: FEED_PAGE, cursor: next } },
        );

        read.push(...res.items);
        if (!after && page === 0) {
          // Without a position, the window is what lies within the overlap of the newest item.
          floor = Math.max(...res.items.map((i) => Date.parse(i.createdAt))) - OVERLAP_MS;
        }

        const oldest = res.items.at(-1);
        if (!res.nextCursor || !oldest || Date.parse(oldest.createdAt) < floor) {
          break;
        }

        next = JSON.stringify(res.nextCursor);
      }

      // No cursor at all is the first poll (intake decides if it is a baseline); a cursor we cannot use baselines here.
      const baseline = cursor !== undefined && !after;
      const fresh = baseline
        ? []
        : read.filter(
            (i) => !after || (Date.parse(i.createdAt) >= floor && !after.seen.has(String(i.id))),
          );

      const ordered = fresh.toSorted(
        (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id,
      );

      const events: TrackerEvent[] = [];
      for (const item of ordered) {
        const type = eventType(item);
        if (!type) {
          continue;
        }

        events.push({
          externalId: `itsaplan:${item.id}`,
          type,
          key: `${setup.project.key}-${item.issueSequence}`,
          actor: actor(setup, item),
          at: item.createdAt,
          data: {
            ...(type === "commented"
              ? {
                  commentId: String(item.id),
                  url: `${api.issueUrl(`${setup.project.key}-${item.issueSequence}`)}#comment-${item.id}`,
                }
              : {}),
            ...(item.issueTitle ? { title: item.issueTitle } : {}),
            ...(item.body ? { body: item.body } : {}),
            ...(type === "commented" ? mentionData(item.body) : {}),
            ...(item.payload?.from?.value ? { from: item.payload.from.value } : {}),
            ...(item.payload?.to?.value ? { to: item.payload.to.value } : {}),
          },
        });
      }

      const times = read.map((i) => Date.parse(i.createdAt)).filter((t) => !Number.isNaN(t));
      const newest = Math.max(after?.since ?? Number.NEGATIVE_INFINITY, ...times);
      const since = new Date(Number.isFinite(newest) ? newest : Date.now()).toISOString();
      // Ids read at baseline time, kept while they are inside the overlap so that history is not handed back as news.
      const keep = after?.seen;
      const seenIds = read
        .filter(
          (i) =>
            (keep ? keep.has(String(i.id)) : true) &&
            Date.parse(i.createdAt) >= Date.parse(since) - OVERLAP_MS,
        )
        .map((i) => String(i.id));

      return {
        events,
        cursor: JSON.stringify({ since, ...(seenIds.length > 0 ? { seen: seenIds } : {}) }),
      };
    },
  };
}

/** Activity actions other than these (labels, priority, links and so on) are not events the office acts on. */
export function eventType(item: ApiActivityItem): TrackerEvent["type"] | undefined {
  if (item.kind === "comment") {
    return "commented";
  }

  const action = (item.action ?? "").toLowerCase();
  if (action === "created" || action === "create") {
    return "created";
  }

  if (/assign/.test(action)) {
    return "assigned";
  }

  if (/^(status|state|column|moved|move)/.test(action)) {
    return "moved";
  }

  return undefined;
}
