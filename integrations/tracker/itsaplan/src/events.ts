import { mentionData, type EventPage, type Member, type TrackerEvent } from "@outstaff/core";
import type { Itsaplan } from "./client.js";
import { OVERLAP_MS, parseCursor } from "./cursor.js";
import { FEED_PAGE } from "./issues.js";
import type { ApiActivityItem, ApiFeedItem, ApiProject, Page } from "./types.js";

const EVENT_PAGES = 20;

/** One page of tracker events from the project's activity feed, after `cursor`. */
export async function readEvents(
  api: Itsaplan,
  actor: (setup: ApiProject, item: ApiFeedItem) => Member,
  cursor: string | undefined,
): Promise<EventPage<TrackerEvent>> {
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
