import type { Tracker, Vcs } from "@outstaff/core";
import type { Ref } from "@outstaff/protocol";
import type { Store, WorkItem } from "./store/types.js";
import type { DocRecord, PrRecord, TicketRecord } from "./workstate/index.js";

type Subject = NonNullable<WorkItem["subject"]>;

/** The tickets and pull requests an item concerns, as links the agent and the requester can open. */
export function itemRefs(store: Store, ports?: { tracker?: Tracker; vcs?: Vcs }) {
  const record = async <T>(type: string, ref: string) =>
    (await store.getSubject(type, ref))?.data as T | undefined;

  const issueUrl = (key: string) => ports?.tracker?.links.issue(key);
  const prUrl = (rec: PrRecord) => ports?.vcs?.links.pr(rec.ref.repo, rec.ref.number);

  const ticketRef = async (key: string): Promise<Ref> => {
    const rec = await record<TicketRecord>("ticket", key);
    const url = rec?.url ?? issueUrl(key);
    return {
      type: "ticket",
      ref: key,
      ...(rec ? { title: rec.title } : {}),
      ...(url ? { url } : {}),
    };
  };

  const prRef = async (key: string, person?: string): Promise<Ref> => {
    const rec = await record<PrRecord>("pr", key);
    if (!rec) {
      return { type: "pr", ref: key };
    }

    const url = rec.url ?? prUrl(rec);
    return {
      type: "pr",
      ref: key,
      title: rec.title,
      ...(url ? { url } : {}),
      headRef: rec.headRef,
      baseRef: rec.baseRef,
      state: rec.state,
      ...(person !== undefined ? { own: rec.author.person === person } : {}),
    };
  };

  /** A ticket's own link and those of the pull requests that implement it. */
  const ofTicket = async (subject: Subject, person: string): Promise<Ref[]> => {
    const prs = await store.queryLinks({
      to: { type: "ticket", ref: subject.ref },
      relation: "implements",
    });

    return [
      await ticketRef(subject.ref),
      ...(await Promise.all(
        prs.filter((l) => l.from.type === "pr").map((l) => prRef(l.from.ref, person)),
      )),
    ];
  };

  /** A pull request, its ticket, and the pull request it is stacked on. */
  const ofPr = async (subject: Subject, person: string): Promise<Ref[]> => {
    const rec = await record<PrRecord>("pr", subject.ref);
    const stacked = await store.queryLinks({
      from: { type: "pr", ref: subject.ref },
      relation: "stacked_on",
    });

    return [
      await prRef(subject.ref, person),
      ...(rec?.ticket ? [await ticketRef(rec.ticket)] : []),
      ...(await Promise.all(stacked.map((l) => prRef(l.to.ref, person)))),
    ];
  };

  /** A document and the ticket it was written for. */
  const ofDoc = async (subject: Subject): Promise<Ref[]> => {
    const rec = await record<DocRecord>("doc", subject.ref);
    return [
      { type: "doc", ref: subject.ref, ...(rec ? { title: rec.title, url: rec.url } : {}) },
      ...(rec?.ticket ? [await ticketRef(rec.ticket)] : []),
    ];
  };

  const bySubject = new Map<string, (subject: Subject, person: string) => Promise<Ref[]>>([
    ["ticket", ofTicket],
    ["pr", ofPr],
    ["doc", ofDoc],
  ]);

  /** The item's own subject, plus the ticket and pull requests it is connected to. */
  const subjectsOf = async (item: WorkItem): Promise<Ref[]> => {
    const subject = item.subject;
    if (!subject) {
      return [];
    }

    const refs = bySubject.get(subject.type);
    return refs ? refs(subject, item.person) : [{ type: subject.type, ref: subject.ref }];
  };

  return { subjectsOf, ticketRef, prRef };
}
