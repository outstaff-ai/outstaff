import type { Tracker, Vcs } from "@outstaff/core";
import type { Ref } from "@outstaff/protocol";
import type { Store, WorkItem } from "./store/types.js";
import type { DocRecord, PrRecord, TicketRecord } from "./workstate/index.js";

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

    if (subject.type === "doc") {
      const rec = (await store.getSubject("doc", subject.ref))?.data as DocRecord | undefined;
      return [
        {
          type: "doc",
          ref: subject.ref,
          ...(rec ? { title: rec.title, url: rec.url } : {}),
        },
        ...(rec?.ticket ? [await ticketRef(rec.ticket)] : []),
      ];
    }

    return [{ type: subject.type, ref: subject.ref }];
  };

  return { subjectsOf, ticketRef, prRef };
}
