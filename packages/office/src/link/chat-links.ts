import type { LinkItem } from "@outstaff/protocol";
import { readOrigin } from "#/chat/origin.js";
import type { ChatOriginRecord } from "#/chat/types.js";
import { CHAT_KIND } from "#/scheduler/policy.js";
import type { WorkItem } from "#/store/types.js";
import type { LinkStore } from "./link.types.js";

type ChatLinkStore = Pick<
  LinkStore,
  "getItem" | "getSubject" | "listItemRefs" | "findItemRefs" | "listRuns"
>;

type How = LinkItem["attached"][number]["how"];

/**
 * How a chat session and a work item of the same person are tied, if they are: the session filed the work (it is the
 * work's parent, from the thread's trigger), attached a request to it, or answered later in the thread of that work.
 */
async function howTied(
  store: ChatLinkStore,
  session: WorkItem,
  work: WorkItem,
): Promise<How | undefined> {
  const origin: Partial<ChatOriginRecord> = (await readOrigin(store, session.id)) ?? {};
  const ties: [boolean, How][] = [
    [origin.attached?.includes(work.id) === true, "attached"],
    [work.parentId === session.id, "filed"],
    // An attach recorded before the office kept `attached` is the session's last filing without being its child.
    [origin.filed === work.id, "attached"],
    [origin.about?.id === work.id, "about"],
  ];

  return ties.find(([holds]) => holds)?.[1];
}

/** The person's other items that share a chat thread with the item, oldest first; its parent comes along. */
async function threadNeighbours(store: ChatLinkStore, item: WorkItem): Promise<WorkItem[]> {
  const threads = (await store.listItemRefs(item.id)).filter((r) => r.type === "chat_thread");
  const found = await Promise.all(threads.map((t) => store.findItemRefs(t.type, t.ref)));
  const ids = [
    ...new Set([
      ...found.flat().map((r) => r.workItemId),
      ...(item.parentId ? [item.parentId] : []),
    ]),
  ].filter((id) => id !== item.id);

  const items = await Promise.all(ids.map((id) => store.getItem(id)));
  return items
    .filter((i): i is WorkItem => i?.person === item.person)
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** When a chat session's first run started and its last one finished. */
async function sessionTimes(store: ChatLinkStore, session: WorkItem) {
  const runs = await store.listRuns(session.id);
  return {
    startedAt: runs[0]?.startedAt ?? null,
    finishedAt: runs.at(-1)?.finishedAt ?? null,
  };
}

/** For a chat session, the work it filed, attached to or was about; for other work, the chat sessions tied to it. */
export async function chatLinks(
  store: ChatLinkStore,
  item: WorkItem,
): Promise<Pick<LinkItem, "attached" | "chatSessions">> {
  const chat = item.kind === CHAT_KIND;
  const others = (await threadNeighbours(store, item)).filter(
    (i) => (i.kind === CHAT_KIND) !== chat,
  );

  const tied = await Promise.all(
    others.map(async (other) => ({
      other,
      how: await (chat ? howTied(store, item, other) : howTied(store, other, item)),
    })),
  );

  const links = tied.flatMap((t) => (t.how ? [{ other: t.other, how: t.how }] : []));
  if (chat) {
    return {
      attached: links.map(({ other, how }) => ({
        id: other.id,
        kind: other.kind,
        title: other.title,
        subject: other.subject,
        how,
      })),
      chatSessions: [],
    };
  }

  return {
    attached: [],
    chatSessions: await Promise.all(
      links.map(async ({ other, how }) => ({
        id: other.id,
        person: other.person,
        ...(await sessionTimes(store, other)),
        how,
      })),
    ),
  };
}
