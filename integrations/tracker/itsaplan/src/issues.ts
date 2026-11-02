import type { Issue, LinkedIssue, Member } from "@outstaff/core";
import type {
  ApiFeedItem,
  ApiIssue,
  ApiIssueLink,
  ApiProject,
  Itsaplan,
  Page,
} from "@outstaff/integration.shared.itsaplan";
import type { Statuses } from "./types.js";

const HYDRATE_CONCURRENCY = 5;
export const FEED_PAGE = 100;

/** Reading and writing issues through the client: the shapes the tracker methods share. */
export function issueHelpers(api: Itsaplan, statuses: Statuses) {
  /** The other ends of the issue's `blocks` links in one direction: outward it blocks them, inward they block it. */
  const blockLinks = (
    links: ApiIssueLink[],
    direction: ApiIssueLink["direction"],
    setup: ApiProject,
  ): LinkedIssue[] =>
    links
      .filter((l) => l.kind === "blocks" && l.direction === direction)
      .map((l) => ({ key: l.issue.identifier, status: statuses.status(setup, l.issue.columnId) }));

  /** The tickets the issue blocks and is blocked by; none said when the answer carries no links. */
  const blocking = (raw: ApiIssue, setup: ApiProject): Pick<Issue, "blocks" | "blockedBy"> =>
    raw.links
      ? {
          blocks: blockLinks(raw.links, "outward", setup),
          blockedBy: blockLinks(raw.links, "inward", setup),
        }
      : {};

  const toIssue = (raw: ApiIssue, setup: ApiProject): Issue => {
    const assignee = raw.assigneeUserId ? api.member(setup, raw.assigneeUserId) : undefined;
    return {
      key: raw.identifier,
      id: String(raw.id),
      title: raw.title,
      body: raw.description ?? "",
      status: statuses.status(setup, raw.columnId),
      ...(assignee ? { assignee } : {}),
      labels: (raw.labelIds ?? [])
        .map((id) => setup.labels.find((l) => l.id === id)?.name)
        .filter((n): n is string => n !== undefined),
      url: api.issueUrl(raw.identifier),
      updatedAt: raw.updatedAt,
      ...blocking(raw, setup),
    };
  };

  const fetchIssue = (key: string): Promise<ApiIssue> => api.issue(key);

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

  return { toIssue, fetchIssue, labelIds, hydrate, patch, commentFeed, actor };
}
