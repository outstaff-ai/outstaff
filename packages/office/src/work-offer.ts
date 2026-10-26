import type { Tracker, Vcs } from "@outstaff/core";
import { publicOrigin, readOrigin } from "./chat/origin.js";
import { previousConversation } from "./conversation-context.js";
import { deliverFeedback, readFeedback } from "./engine/feedback.js";
import { itemRefs } from "./item-refs.js";
import type { Offer } from "./protocol/index.js";
import { INTERRUPTED } from "./scheduler/index.js";
import type { Store, WorkItem } from "./store/types.js";

/** Builds the offer of an item: the item itself with its origin, journal, subjects, feedback and conversation. */
export function offerBuilder(store: Store, ports?: { tracker?: Tracker; vcs?: Vcs }) {
  const { subjectsOf } = itemRefs(store, ports);

  // A new offer counts as delivering the feedback it carries; a resumed one the agent already has.
  return async (item: WorkItem, fresh = true): Promise<Offer> => {
    const origin = await readOrigin(store, item.id);
    // A chat session answering in the thread of running work sees that work: its ticket, pull request and journal.
    const about = origin?.about ? await store.getItem(origin.about.id) : undefined;
    const mine = await subjectsOf(item);
    const subjects = about
      ? [...(await subjectsOf(about)), ...mine].filter(
          (s, i, all) => all.findIndex((x) => x.type === s.type && x.ref === s.ref) === i,
        )
      : mine;

    const feedback = fresh
      ? await deliverFeedback(store, item.id)
      : await readFeedback(store, item.id);

    const conversation = await previousConversation(store, ports?.vcs, item, feedback);

    // This run is the latest; the one before it is what the agent continues.
    const interrupted = (await store.listRuns(item.id)).at(-2)?.outcome === INTERRUPTED;

    return {
      ...(item.sessionId ? { sessionId: item.sessionId } : {}),
      ...(interrupted ? { interrupted } : {}),
      workItem: {
        id: item.id,
        kind: item.kind,
        title: item.title,
        priority: item.priority,
        trigger: item.trigger,
        ...(item.parentId ? { parentId: item.parentId } : {}),
        ...(item.subject ? { subject: item.subject } : {}),
        ...(origin ? { origin: publicOrigin(origin) } : {}),
      },
      context: {
        journal: [
          ...(about ? await store.readJournal(about.id) : []),
          ...(await store.readJournal(item.id)),
        ].map((j) => ({
          at: j.at,
          author: j.author,
          text: j.text,
        })),
        subjects,
        links: subjects.flatMap((s) => (s.url ? [{ url: s.url, title: s.title ?? s.ref }] : [])),
        ...(feedback.length > 0 ? { feedback } : {}),
        ...(conversation.length > 0 ? { conversation } : {}),
      },
    };
  };
}
