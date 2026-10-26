import type { Link, Member, WorkSummary } from "@outstaff/protocol";
import { ProtocolError, type Offer, type WorkSource } from "./source.js";

type State =
  | "queued"
  | "offered"
  | "accepted"
  | "done"
  | "failed"
  | "waiting"
  | "blocked"
  | "canceled";

export interface FakeSource extends WorkSource {
  enqueue(person: string, id: string, title?: string): Offer;
  stateOf(id: string): State | undefined;

  /** Every call the server made, as `method:person:id`. */
  calls: string[];
  sessions: Map<string, string>;
  journalLines: { id: string; text: string }[];
  handBacks: { id: string; summary: string; links: Link[]; status: string }[];
  failNext(error: Error): void;
}

export function createFakeSource(members: Member[] = []): FakeSource {
  const items = new Map<string, { person: string; offer: Offer; state: State; title: string }>();
  const calls: string[] = [];
  const sessions = new Map<string, string>();
  const journalLines: FakeSource["journalLines"] = [];
  const handBacks: FakeSource["handBacks"] = [];
  let failure: Error | undefined;

  const find = (person: string, id: string) => {
    const it = items.get(id);
    if (!it || it.person !== person) {
      throw new ProtocolError("unknown_item", `No work item ${id} for ${person}.`);
    }

    return it;
  };

  const record = (method: string, person: string, id = "") => {
    calls.push(`${method}:${person}:${id}`);
    if (failure) {
      const f = failure;
      failure = undefined;
      throw f;
    }
  };

  const summary = (id: string, it: { state: State; title: string }): WorkSummary => ({
    id,
    title: it.title,
    status: it.state,
  });

  return {
    calls,
    sessions,
    journalLines,
    handBacks,
    failNext: (e) => {
      failure = e;
    },
    stateOf: (id) => items.get(id)?.state,
    enqueue(person, id, title = `Item ${id}`) {
      const offer: Offer = {
        workItem: { id, kind: "ticket", title, priority: 100, trigger: "human" },
        context: { journal: [], subjects: [], links: [] },
      };

      items.set(id, { person, offer, state: "queued", title });
      return offer;
    },
    async outstanding(person) {
      return [...items.values()]
        .filter((i) => i.person === person && (i.state === "offered" || i.state === "accepted"))
        .map((i) => ({ offer: i.offer, accepted: i.state === "accepted" }));
    },
    async next(person) {
      const busy = [...items.values()].some(
        (i) => i.person === person && (i.state === "offered" || i.state === "accepted"),
      );

      const it = busy
        ? undefined
        : [...items.values()].find((i) => i.person === person && i.state === "queued");

      if (it) {
        it.state = "offered";
      }

      return it?.offer;
    },
    async accept(person, id) {
      record("accept", person, id);
      find(person, id).state = "accepted";
    },
    async decline(person, id) {
      record("decline", person, id);
      find(person, id).state = "queued";
    },
    async heartbeat(person, id) {
      record("heartbeat", person, id);
    },
    async progress(person, id) {
      record("progress", person, id);
    },
    async setSession(person, id, sessionId) {
      record("session", person, id);
      find(person, id);
      sessions.set(id, sessionId);
      const it = items.get(id);
      if (it) {
        it.offer = { ...it.offer, sessionId };
      }
    },
    async journal(person, id, text) {
      record("journal", person, id);
      find(person, id);
      journalLines.push({ id, text });
    },
    async handBack(person, id, result) {
      record("handback", person, id);
      find(person, id).state = result.status === "interrupted" ? "queued" : result.status;
      handBacks.push({ id, ...result });
    },
    async fail(person, id) {
      record("fail", person, id);
      find(person, id).state = "failed";
    },
    async roster() {
      return members;
    },
    async list(person, q) {
      return [...items.entries()]
        .filter(
          ([id, i]) => i.person === person && (q.workItemId === undefined || id === q.workItemId),
        )
        .map(([id, i]) => ({
          ...summary(id, i),
          ...(id === q.workItemId ? { current: true } : {}),
        }));
    },
    async move(person, id, status) {
      record("move", person, id);
      const it = find(person, id);
      it.state = status;
      return summary(id, it);
    },
    async place(person, id) {
      record("place", person, id);
      return summary(id, find(person, id));
    },
  };
}
