import type { TeamConfig, Tracker, Vcs } from "@outstaff/core";
import type { Ref } from "@outstaff/protocol";
import type { ChatOriginRecord } from "./chat/types.js";
import { publicOrigin, readOrigin } from "./chat/origin.js";
import { previousConversation } from "./conversation-context.js";
import { deliverFeedback, readFeedback } from "./work-feedback.js";
import { itemRefs } from "./item-refs.js";
import type { Offer } from "./protocol/index.js";
import { INTERRUPTED } from "./scheduler/index.js";
import { contextLimits } from "./pipeline/context/index.js";
import type { Store, WorkItem } from "./store/types.js";
import { wakeContextOf, type WakeContextOptions } from "./wake-context/index.js";

const sameRef = (a: Ref, b: Ref) => a.type === b.type && a.ref === b.ref;

const unique = (refs: Ref[]) =>
  refs.filter((s, i, all) => all.findIndex((x) => sameRef(x, s)) === i);

const linksOf = (subjects: Ref[]) =>
  subjects.flatMap((s) => (s.url ? [{ url: s.url, title: s.title ?? s.ref }] : []));

function offeredItem(item: WorkItem, origin: ChatOriginRecord | undefined): Offer["workItem"] {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    priority: item.priority,
    trigger: item.trigger,
    ...(item.parentId ? { parentId: item.parentId } : {}),
    ...(item.subject ? { subject: item.subject } : {}),
    ...(origin ? { origin: publicOrigin(origin) } : {}),
  };
}

/**
 * Builds the offer of an item: the item itself with its origin, journal, subjects, feedback, conversation, and the
 * context bundle of what the office knows around it.
 */
export function offerBuilder(
  store: Store,
  ports?: { tracker?: Tracker; vcs?: Vcs },
  opts: Omit<WakeContextOptions, "limits"> & { team?: Pick<TeamConfig, "pipeline"> } = {},
) {
  const { subjectsOf } = itemRefs(store, ports);
  const wakeOf = wakeContextOf(
    { store, tracker: ports?.tracker, vcs: ports?.vcs },
    { ...opts, limits: contextLimits(opts.team ?? {}) },
  );

  // A chat session answering in the thread of running work sees that work: its ticket, pull request and journal.
  const aboutOf = async (origin: ChatOriginRecord | undefined) =>
    origin?.about ? await store.getItem(origin.about.id) : undefined;

  const subjectsWith = async (item: WorkItem, about: WorkItem | undefined) => {
    const mine = await subjectsOf(item);
    return about ? unique([...(await subjectsOf(about)), ...mine]) : mine;
  };

  // A new offer counts as delivering the feedback it carries; a resumed one the agent already has.
  const feedbackOf = (id: string, fresh: boolean) =>
    fresh ? deliverFeedback(store, id) : readFeedback(store, id);

  // This run is the latest; the one before it is what the agent continues.
  const interruptedBefore = async (id: string) =>
    (await store.listRuns(id)).at(-2)?.outcome === INTERRUPTED;

  const journalOf = async (item: WorkItem, about: WorkItem | undefined) =>
    [
      ...(about ? await store.readJournal(about.id) : []),
      ...(await store.readJournal(item.id)),
    ].map((j) => ({ at: j.at, author: j.author, text: j.text }));

  return async (item: WorkItem, fresh = true): Promise<Offer> => {
    const origin = await readOrigin(store, item.id);
    const about = await aboutOf(origin);
    const subjects = await subjectsWith(item, about);
    const feedback = await feedbackOf(item.id, fresh);
    const conversation = await previousConversation(store, ports?.vcs, item, feedback);
    const interrupted = await interruptedBefore(item.id);
    const journal = await journalOf(item, about);
    const wake = await wakeOf(item, fresh);
    return {
      ...(item.sessionId ? { sessionId: item.sessionId } : {}),
      ...(interrupted ? { interrupted } : {}),
      workItem: offeredItem(item, origin),
      context: {
        journal,
        subjects,
        links: linksOf(subjects),
        ...(feedback.length > 0 ? { feedback } : {}),
        ...(conversation.length > 0 ? { conversation } : {}),
        ...(wake ? { wake } : {}),
      },
    };
  };
}
