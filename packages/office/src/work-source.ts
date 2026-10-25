import type { Tracker, TeamConfig, Vcs } from "@outstaff/core";
import type { Link, Member, Ref, WorkSummary } from "@outstaff/protocol";
import { ProtocolError, type Offer, type WorkSource } from "./protocol/source.js";
import { readRoster, type RosterOptions } from "./messaging/roster.js";
import { publicOrigin, readOrigin } from "./chat/origin.js";
import { deliverFeedback, readFeedback } from "./engine/feedback.js";
import { previousConversation } from "./conversation-context.js";
import { placeQueued } from "./chat/placement.js";
import { INTERRUPTED, type BlockNotice, type Scheduler } from "./scheduler/scheduler.js";
import type { Store, WorkItem } from "./store/types.js";
import type { PrRecord, TicketRecord } from "./workstate/index.js";

/** The tickets and pull requests an item concerns, as links the agent and the requester can open. */
export function itemRefs(store: Store, ports?: { tracker?: Tracker; vcs?: Vcs }) {
  const ticketRef = async (key: string): Promise<Ref> => {
    const rec = (await store.getSubject("ticket", key))?.data as TicketRecord | undefined;
    const url = rec?.url ?? ports?.tracker?.links.issue(key);
    return {
      type: "ticket",
      ref: key,
      ...(rec ? { title: rec.title } : {}),
      ...(url ? { url } : {}),
    };
  };

  const prRef = async (key: string, person?: string): Promise<Ref> => {
    const rec = (await store.getSubject("pr", key))?.data as PrRecord | undefined;
    const url = rec?.url ?? (rec ? ports?.vcs?.links.pr(rec.ref.repo, rec.ref.number) : undefined);

    return {
      type: "pr",
      ref: key,
      ...(rec ? { title: rec.title } : {}),
      ...(url ? { url } : {}),
      ...(rec
        ? {
            headRef: rec.headRef,
            baseRef: rec.baseRef,
            state: rec.state,
            ...(person !== undefined ? { own: rec.author.person === person } : {}),
          }
        : {}),
    };
  };

  /** The item's own subject, plus the ticket and pull requests it is connected to. */
  const subjectsOf = async (item: WorkItem): Promise<Ref[]> => {
    const subject = item.subject;
    if (!subject) {
      return [];
    }

    if (subject.type === "ticket") {
      const prs = await store.queryLinks({
        to: { type: "ticket", ref: subject.ref },
        relation: "implements",
      });

      return [
        await ticketRef(subject.ref),
        ...(await Promise.all(
          prs.filter((l) => l.from.type === "pr").map((l) => prRef(l.from.ref, item.person)),
        )),
      ];
    }

    if (subject.type === "pr") {
      const rec = (await store.getSubject("pr", subject.ref))?.data as PrRecord | undefined;
      const stacked = await store.queryLinks({
        from: { type: "pr", ref: subject.ref },
        relation: "stacked_on",
      });

      return [
        await prRef(subject.ref, item.person),
        ...(rec?.ticket ? [await ticketRef(rec.ticket)] : []),
        ...(await Promise.all(stacked.map((l) => prRef(l.to.ref, item.person)))),
      ];
    }

    return [{ type: subject.type, ref: subject.ref }];
  };

  return { subjectsOf, ticketRef, prRef };
}

/** An item as the protocol lists it. */
export async function summarizeItem(
  store: Store,
  item: WorkItem,
  current?: string,
): Promise<WorkSummary> {
  let ticketKey: string | undefined;
  let pr: PrRecord | undefined;
  if (item.subject?.type === "ticket") {
    ticketKey = item.subject.ref;
  } else if (item.subject?.type === "pr") {
    pr = (await store.getSubject("pr", item.subject.ref))?.data as PrRecord | undefined;
    ticketKey = pr?.ticket;
  }

  const ticketTitle = ticketKey
    ? ((await store.getSubject("ticket", ticketKey))?.data as TicketRecord | undefined)?.title
    : undefined;

  return {
    id: item.id,
    title: item.title,
    status: item.status,
    kind: item.kind,
    ...(ticketKey ? { ticketKey } : {}),
    ...(ticketTitle ? { ticketTitle } : {}),
    ...(item.subject?.type === "pr" ? { pr: item.subject.ref } : {}),
    ...(pr ? { prNumber: pr.ref.number, prTitle: pr.title } : {}),
    ...(pr?.url ? { prUrl: pr.url } : {}),
    ...(current === item.id ? { current: true } : {}),
  };
}

/** Subject type that keeps whether the agent accepted an offered item; it must survive a restart. */
export const OFFER_SUBJECT = "offer";

const OPEN = new Set(["queued", "active", "waiting", "blocked"]);

export interface HandBackResult {
  summary: string;
  links: Link[];
  status: "done" | "waiting" | "blocked" | "interrupted";
}

export interface WorkSourceOptions {
  scheduler: Scheduler;
  store: Store;
  team: Pick<TeamConfig, "people" | "humans">;
  ports?: { tracker?: Tracker; vcs?: Vcs };
  roles?: RosterOptions["roles"];

  /** Called after the item left `active` because of a hand-back, so the workflow can react (move the ticket, notify). */
  onHandedBack?: (item: WorkItem, result: HandBackResult) => Promise<void>;

  /** Called after an item started, before it is offered. */
  onStarted?: (item: WorkItem) => Promise<void>;

  /** Called after the scheduler blocked an item on its own (repeated failures, loop guard), so the requester hears of it. */
  onBlocked?: (notice: BlockNotice) => void | Promise<void>;

  /** Called after an item went back to the queue because the agent asked for it. */
  notify?: (person: string) => void;
}

interface OfferState {
  accepted: boolean;
}

/** The protocol's `WorkSource` over the real scheduler and store. All its state is in the store. */
export function schedulerWorkSource(opts: WorkSourceOptions): WorkSource {
  const { scheduler, store } = opts;

  const own = async (person: string, id: string): Promise<WorkItem> => {
    const item = await store.getItem(id);
    if (!item || item.person !== person) {
      throw new ProtocolError("unknown_item", `No work item ${id} for ${person}.`);
    }

    return item;
  };

  const stateOf = async (id: string): Promise<OfferState> =>
    ((await store.getSubject(OFFER_SUBJECT, id))?.data as OfferState | undefined) ?? {
      accepted: false,
    };

  const { subjectsOf } = itemRefs(store, opts.ports);

  // A new offer counts as delivering the feedback it carries; a resumed one the agent already has.
  const offerOf = async (item: WorkItem, fresh = true): Promise<Offer> => {
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

    const conversation = await previousConversation(store, opts.ports?.vcs, item, feedback);

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

  const summaryOf = (item: WorkItem, current?: string) => summarizeItem(store, item, current);

  return {
    async outstanding(person) {
      const active = await store.listItems({ person, status: "active" });
      return Promise.all(
        active.map(async (item) => {
          const accepted = (await stateOf(item.id)).accepted;
          return { offer: await offerOf(item, !accepted), accepted };
        }),
      );
    },

    async next(person) {
      const item = await scheduler.next(person);
      if (!item) {
        return undefined;
      }

      const started = await scheduler.markActive(item.id);
      if (!started.started) {
        if (started.blocked) {
          await opts.onBlocked?.(started.blocked);
        }

        return undefined;
      }

      await opts.onStarted?.(started.item);
      await store.upsertSubject(OFFER_SUBJECT, item.id, { accepted: false });
      return offerOf(started.item);
    },

    async accept(person, id) {
      const item = await own(person, id);
      if (item.status !== "active") {
        throw new ProtocolError("invalid", `Work item ${id} is ${item.status}, not offered.`);
      }

      await store.upsertSubject(OFFER_SUBJECT, id, { accepted: true });
    },

    async decline(person, id, reason) {
      const item = await own(person, id);
      // Offered or accepted: an agent that restarted drops what it had accepted too.
      if (item.status !== "active") {
        throw new ProtocolError("invalid", `Work item ${id} is not running.`);
      }

      // The item stays as it is (same run, attempt, journal and session) and is only offered again.
      await store.appendJournal(id, person, `Gave the item back: ${reason}`);
      await store.upsertSubject(OFFER_SUBJECT, id, { accepted: false });
      await scheduler.heartbeat(id);
      opts.notify?.(person);
    },

    async heartbeat(person, id) {
      if (id) {
        await own(person, id);
        await scheduler.heartbeat(id);
      }
    },

    async progress(person, id, text) {
      await own(person, id);
      await store.appendJournal(id, person, `Progress: ${text}`);
      await scheduler.heartbeat(id);
    },

    async setSession(person, id, sessionId) {
      await own(person, id);
      await store.updateItem(id, { sessionId });
    },

    async journal(person, id, text) {
      await own(person, id);
      await store.appendJournal(id, person, text);
    },

    async handBack(person, id, result) {
      const item = await own(person, id);
      // A retried hand-back finds the item already finished and only repeats the follow-up.
      if (item.status === "active") {
        const links = result.links.map((l) => `- ${l.title ? `${l.title}: ` : ""}${l.url}`);
        await store.appendJournal(
          id,
          person,
          [result.summary, ...(links.length > 0 ? ["", "Links:", ...links] : [])].join("\n"),
        );

        if (result.status === "blocked") {
          await scheduler.block(id, result.summary);
        } else if (result.status === "interrupted") {
          await scheduler.interrupt(id, result.summary);
        } else {
          await scheduler.finish(id, { outcome: result.summary, status: result.status });
        }
      } else if (
        result.status !== "interrupted" &&
        item.status !== "done" &&
        item.status !== "waiting" &&
        item.status !== "blocked"
      ) {
        throw new ProtocolError("invalid", `Work item ${id} is ${item.status}, not running.`);
      }

      await opts.onHandedBack?.((await store.getItem(id)) ?? item, result);
    },

    async fail(person, id, reason) {
      const item = await own(person, id);
      if (item.status !== "active") {
        return;
      }

      await store.appendJournal(id, person, `The run failed: ${reason}`);
      const failed = await scheduler.fail(id, reason);
      if (failed.blocked) {
        await opts.onBlocked?.(failed.blocked);
      }
    },

    async roster(): Promise<Member[]> {
      return (
        await readRoster({
          store,
          team: opts.team,
          ...(opts.roles ? { roles: opts.roles } : {}),
        })
      ).members;
    },

    async list(person, q) {
      const items = (await store.listItems({ person }))
        .filter((i) => OPEN.has(i.status))
        .toSorted((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

      return Promise.all(items.map((i) => summaryOf(i, q.workItemId)));
    },

    async place(person, id, position, relativeTo) {
      const item = await own(person, id);
      if (item.status !== "queued") {
        throw new ProtocolError(
          "invalid",
          `Work item ${id} is ${item.status}; only queued items can be placed.`,
        );
      }

      if ((position === "before" || position === "after") && !relativeTo) {
        throw new ProtocolError("invalid", `Say which item it goes ${position}.`);
      }

      try {
        await placeQueued(
          { store, scheduler },
          id,
          position === "before" || position === "after"
            ? position === "before"
              ? { before: relativeTo! }
              : { after: relativeTo! }
            : position,
        );
      } catch (error) {
        throw new ProtocolError("invalid", error instanceof Error ? error.message : String(error));
      }

      const origin = await readOrigin(store, id);
      if (origin?.awaitingPlacement) {
        await store.upsertSubject("chat_origin", id, { ...origin, awaitingPlacement: false });
      }

      await store.appendJournal(
        id,
        person,
        `Placed ${position}${relativeTo ? ` ${relativeTo}` : ""}.`,
      );

      opts.notify?.(person);
      return summaryOf((await store.getItem(id)) ?? item, id);
    },

    async move(person, id, status) {
      const item = await own(person, id);
      if (status === "queued") {
        if (item.status !== "blocked" && item.status !== "waiting") {
          throw new ProtocolError(
            "invalid",
            `Work item ${id} is ${item.status}; it cannot be queued.`,
          );
        }

        await store.appendJournal(id, person, "Queued again by the agent.");
        const updated = await store.updateItem(id, { status: "queued" });
        opts.notify?.(person);
        return summaryOf(updated, id);
      }

      if (status === "blocked") {
        if (item.status !== "queued" && item.status !== "waiting") {
          throw new ProtocolError(
            "invalid",
            `Work item ${id} is ${item.status}; it cannot be blocked.`,
          );
        }

        await scheduler.block(id, `${person} blocked it.`);
        return summaryOf((await store.getItem(id)) ?? item, id);
      }

      if (item.status === "done" || item.status === "canceled") {
        throw new ProtocolError("invalid", `Work item ${id} is already ${item.status}.`);
      }

      if (item.status === "active") {
        await scheduler.finish(id, { outcome: `canceled by ${person}`, status: "canceled" });
      } else {
        await store.updateItem(id, { status: "canceled" });
      }

      await store.appendJournal(id, person, "Canceled by the agent.");
      return summaryOf((await store.getItem(id)) ?? item, id);
    },
  };
}
