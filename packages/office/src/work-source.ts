import type { Tracker, TeamConfig, Vcs } from "@outstaff/core";
import type { Link, Member, Ref, WorkSummary } from "@outstaff/protocol";
import { ProtocolError, type Offer, type WorkSource } from "./protocol/source.js";
import { readRoster, type RosterOptions } from "./messaging/roster.js";
import type { Scheduler } from "./scheduler/scheduler.js";
import type { Store, WorkItem } from "./store/types.js";
import type { PrRecord, TicketRecord } from "./workstate/index.js";

/** Subject type that keeps whether the agent accepted an offered item; it must survive a restart. */
export const OFFER_SUBJECT = "offer";

const OPEN = new Set(["queued", "active", "waiting", "blocked"]);

export interface HandBackResult {
  summary: string;
  links: Link[];
  status: "done" | "waiting" | "blocked";
}

export interface WorkSourceOptions {
  scheduler: Scheduler;
  store: Store;
  team: Pick<TeamConfig, "people" | "humans">;
  ports?: { tracker?: Tracker; vcs?: Vcs };
  roles?: RosterOptions["roles"];

  /** Called after the item left `active` because of a hand-back, so the workflow can react (move the ticket, notify). */
  onHandedBack?: (item: WorkItem, result: HandBackResult) => Promise<void>;

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

  const ticketRef = async (key: string): Promise<Ref> => {
    const rec = (await store.getSubject("ticket", key))?.data as TicketRecord | undefined;
    const url = rec?.url ?? opts.ports?.tracker?.links.issue(key);
    return {
      type: "ticket",
      ref: key,
      ...(rec ? { title: rec.title } : {}),
      ...(url ? { url } : {}),
    };
  };

  const prRef = async (key: string): Promise<Ref> => {
    const rec = (await store.getSubject("pr", key))?.data as PrRecord | undefined;
    const url =
      rec?.url ?? (rec ? opts.ports?.vcs?.links.pr(rec.ref.repo, rec.ref.number) : undefined);

    return {
      type: "pr",
      ref: key,
      ...(rec ? { title: rec.title } : {}),
      ...(url ? { url } : {}),
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
          prs.filter((l) => l.from.type === "pr").map((l) => prRef(l.from.ref)),
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
        await prRef(subject.ref),
        ...(rec?.ticket ? [await ticketRef(rec.ticket)] : []),
        ...(await Promise.all(stacked.map((l) => prRef(l.to.ref)))),
      ];
    }

    return [{ type: subject.type, ref: subject.ref }];
  };

  const offerOf = async (item: WorkItem): Promise<Offer> => {
    const subjects = await subjectsOf(item);
    return {
      workItem: {
        id: item.id,
        kind: item.kind,
        title: item.title,
        priority: item.priority,
        trigger: item.trigger,
        ...(item.parentId ? { parentId: item.parentId } : {}),
        ...(item.subject ? { subject: item.subject } : {}),
      },
      context: {
        journal: (await store.readJournal(item.id)).map((j) => ({
          at: j.at,
          author: j.author,
          text: j.text,
        })),
        subjects,
        links: subjects.flatMap((s) => (s.url ? [{ url: s.url, title: s.title ?? s.ref }] : [])),
      },
    };
  };

  const summaryOf = async (item: WorkItem, current?: string): Promise<WorkSummary> => {
    let ticketKey: string | undefined;
    let prUrl: string | undefined;
    if (item.subject?.type === "ticket") {
      ticketKey = item.subject.ref;
    } else if (item.subject?.type === "pr") {
      const rec = (await store.getSubject("pr", item.subject.ref))?.data as PrRecord | undefined;
      ticketKey = rec?.ticket;
      prUrl = rec?.url;
    }

    return {
      id: item.id,
      title: item.title,
      status: item.status,
      ...(ticketKey ? { ticketKey } : {}),
      ...(prUrl ? { prUrl } : {}),
      ...(current === item.id ? { current: true } : {}),
    };
  };

  return {
    async outstanding(person) {
      const active = await store.listItems({ person, status: "active" });
      return Promise.all(
        active.map(async (item) => ({
          offer: await offerOf(item),
          accepted: (await stateOf(item.id)).accepted,
        })),
      );
    },

    async next(person) {
      const item = await scheduler.next(person);
      if (!item) {
        return undefined;
      }

      const started = await scheduler.markActive(item.id);
      if (!started.started) {
        return undefined;
      }

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
      if (item.status !== "active" || (await stateOf(id)).accepted) {
        throw new ProtocolError("invalid", `Work item ${id} is not an open offer.`);
      }

      await store.appendJournal(id, person, `Declined the offer: ${reason}`);
      await scheduler.finish(id, { outcome: `declined: ${reason}`, status: "queued" });
      await store.upsertSubject(OFFER_SUBJECT, id, { accepted: false });
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
        } else {
          await scheduler.finish(id, { outcome: result.summary, status: result.status });
        }
      } else if (item.status !== "done" && item.status !== "waiting" && item.status !== "blocked") {
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
      await scheduler.finish(id, { outcome: "failed", error: reason, status: "queued" });
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
