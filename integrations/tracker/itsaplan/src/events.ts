import { mentionData, type EventPage, type Member, type TrackerEvent } from "@outstaff/core";
import {
  nextCursor,
  OVERLAP_MS,
  parseCursor,
  type ApiActivityItem,
  type ApiFeedItem,
  type ApiProject,
  type EventCursor,
  type Itsaplan,
  type Page,
} from "@outstaff/integration.shared.itsaplan";
import { FEED_PAGE } from "./issues.js";

const EVENT_PAGES = 20;

const at = (item: ApiActivityItem) => Date.parse(item.createdAt);

/** Whether this feed page is the last to read: the feed ends, or it reaches older than the floor. */
function lastPage(res: Page<ApiActivityItem>, floor: number): boolean {
  const oldest = res.items.at(-1);
  return !res.nextCursor || !oldest || at(oldest) < floor;
}

/**
 * Pages back through the feed (newest first) until a page reaches older than the overlap window. Returns what was
 * read and the floor of the window. Without a usable position the window is what lies within the overlap of the
 * newest item.
 */
async function readFeed(
  api: Itsaplan,
  after: EventCursor | undefined,
): Promise<{ read: ApiActivityItem[]; floor: number }> {
  const read: ApiActivityItem[] = [];
  let next: string | undefined;
  let floor = (after?.since ?? Number.NaN) - OVERLAP_MS;
  for (let page = 0; page < EVENT_PAGES; page++) {
    const res = await api.http.request<Page<ApiActivityItem>>(
      "GET",
      `${api.projectPath}/analytics/activity`,
      { query: { limit: FEED_PAGE, cursor: next } },
    );

    read.push(...res.items);
    if (!after && page === 0) {
      floor = Math.max(...res.items.map(at)) - OVERLAP_MS;
    }

    if (lastPage(res, floor)) {
      break;
    }

    next = JSON.stringify(res.nextCursor);
  }

  return { read, floor };
}

/** The data of a comment event: its id and link. */
function commentLink(api: Itsaplan, key: string, item: ApiActivityItem) {
  return {
    commentId: String(item.id),
    url: `${api.issueUrl(key)}#comment-${item.id}`,
  };
}

/** The status change of a move, where the feed has it. */
function change(item: ApiActivityItem) {
  const from = item.payload?.from?.value;
  const to = item.payload?.to?.value;
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

function toEvent(
  api: Itsaplan,
  setup: ApiProject,
  actor: Member,
  item: ApiActivityItem,
  type: TrackerEvent["type"],
): TrackerEvent {
  const key = `${setup.project.key}-${item.issueSequence}`;
  const comment = type === "commented";
  return {
    externalId: `itsaplan:${item.id}`,
    type,
    key,
    actor,
    at: item.createdAt,
    data: {
      ...(comment ? commentLink(api, key, item) : {}),
      ...(item.issueTitle ? { title: item.issueTitle } : {}),
      ...(item.body ? { body: item.body } : {}),
      ...(comment ? mentionData(item.body) : {}),
      ...change(item),
    },
  };
}

/** One page of tracker events from the project's activity feed, after `cursor`. */
export async function readEvents(
  api: Itsaplan,
  actor: (setup: ApiProject, item: ApiFeedItem) => Member,
  cursor: string | undefined,
): Promise<EventPage<TrackerEvent>> {
  // Activity ids are identifiers only; progress is tracked by createdAt.
  const after = parseCursor(cursor);
  const setup = await api.project();
  const { read, floor } = await readFeed(api, after);
  // No cursor at all is the first poll (intake decides if it is a baseline); a cursor we cannot use baselines here.
  const baseline = cursor !== undefined && !after;
  const isNew = (i: ApiActivityItem) => !after || (at(i) >= floor && !after.seen.has(String(i.id)));
  const fresh = baseline ? [] : read.filter(isNew);
  const events: TrackerEvent[] = [];
  for (const item of fresh.toSorted((a, b) => at(a) - at(b) || a.id - b.id)) {
    const type = eventType(item);
    if (type) {
      events.push(toEvent(api, setup, actor(setup, item), item, type));
    }
  }

  const seen = read.map((i) => ({ id: String(i.id), at: at(i) }));
  return { events, cursor: nextCursor(after, seen, Date.now) };
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
