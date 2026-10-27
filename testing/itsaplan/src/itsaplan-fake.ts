import type { Doc, Member } from "@outstaff/core";
import type { KnowledgeSeed, TrackerSeed } from "@outstaff/core/contracts";
import { findRange, mdToDoc } from "@outstaff/integration.knowledge.itsaplan";
import { createStubFetch } from "./http-stub.js";
import { createItsaplanStandIn, err } from "./stand-in/index.js";
import type { ItsaplanStore, StoredDoc } from "./stand-in/index.js";
import type { FakeOptions, Route } from "./types.js";

// The Its a Plan stand-in in process: served through the stub fetch, with Its a Plan's checks on comments, the
// seeds of the contract kits and an issue and a document the actor may not read.

const forbidden: Route[] = [
  {
    method: "GET",
    path: "/projects/:p/issues/403",
    handler: () => err(403, "You cannot read this issue.", "forbidden"),
  },
  {
    method: "GET",
    path: "/projects/:p/documents/403",
    handler: () => err(403, "You cannot read this document.", "forbidden"),
  },
];

const trackerSeed = (s: ItsaplanStore): TrackerSeed => ({
  async member(m) {
    const userId = `u-${s.members.length + 1}`;
    s.members.push({ userId, name: m.name, username: m.name.toLowerCase(), kind: "member" });
    return { id: userId, name: m.name, kind: m.kind ?? "human" } satisfies Member;
  },
  forbiddenCall: () => Promise.reject(new Error("bound by the test")),
});

const knowledgeSeed = (s: ItsaplanStore): KnowledgeSeed => ({
  async doc(d) {
    const row: StoredDoc = {
      id: ++s.counters.doc,
      parentId: null,
      title: d.title,
      metadata: { path: d.path },
      version: 1,
      content: d.body,
      contentJson: mdToDoc(d.body),
      createdAt: s.now(),
      updatedAt: s.now(),
    };

    s.docs.push(row);
    return {
      id: String(row.id),
      path: d.path,
      title: d.title,
      body: d.body,
      url: "",
      version: "1",
      updatedAt: row.updatedAt,
    } satisfies Doc;
  },
});

export function createItsaplanFake(opts: FakeOptions = {}) {
  const { store, routes } = createItsaplanStandIn({
    ...opts,
    documents: { quoteRange: findRange },
  });

  const stub = createStubFetch([...forbidden, ...routes]);
  const { issues, activity, columns, labels, members, attachments, docs, docComments } = store;
  return {
    fetch: stub.fetch,
    calls: stub.calls,
    called: stub.called,
    state: {
      issues,
      activity,
      columns,
      labels,
      assignees: members,
      attachments,
      docs,
      docComments,
    },
    trackerSeed: trackerSeed(store),
    knowledgeSeed: knowledgeSeed(store),
    project: { key: store.key, ref: store.ref },
    clock: store.now,
  };
}
