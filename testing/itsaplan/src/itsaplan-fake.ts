import type { Doc, Member } from "@outstaff/core";
import type { KnowledgeSeed, TrackerSeed } from "@outstaff/core/contracts";
import { createStubFetch } from "./http-stub.js";
import { createItsaplanStandIn, err } from "./stand-in/index.js";
import { createIssue } from "./stand-in/model.js";
import { addDoc, changeDoc } from "./stand-in/doc-model.js";
import { NOTES_ROOT } from "./stand-in/notes.js";
import type { ItsaplanStore } from "./stand-in/index.js";
import type { FakeOptions, Markdown, Route } from "./types.js";

// The Its a Plan stand-in in process: served through the stub fetch, with the seeds of the contract kits and an
// issue and a document the actor may not read. With `markdown` (the knowledge adapter's own conversion), seeded
// documents get their editor JSON and comments get Its a Plan's checks on quotes.

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
  async repository(repo, numbers) {
    const id = s.repositories.length + 1;
    const fullName = `${repo.owner}/${repo.name}`;
    const webUrl = `https://git.acme.example/${fullName}`;
    s.repositories.push({ id, provider: "github", fullName, webUrl });
    s.pullRequests.set(
      id,
      numbers.map((number) => ({
        number,
        title: `Change ${number}`,
        url: `${webUrl}/pull/${number}`,
        state: "open",
        draft: false,
        sourceBranch: `change-${number}`,
        targetBranch: "main",
        headSha: null,
        updatedAt: s.now(),
      })),
    );
  },
  forbiddenCall: () => Promise.reject(new Error("bound by the test")),
});

/** The page of `owner`'s notes under the reserved root, as the knowledge adapter lays them out. */
const notesPage = (s: ItsaplanStore, owner: string) => {
  const root = s.docs.find((d) => d.title === NOTES_ROOT && d.parentId === null);
  return root && s.docs.find((d) => d.parentId === root.id && d.title === owner);
};

/** Writes `owner`'s notes as a new member named `by.name`, creating the page (and the root) when missing. */
function editNotes(
  s: ItsaplanStore,
  markdown: Markdown | undefined,
  owner: string,
  notes: string[],
  by: { name: string; kind: Member["kind"] },
): Member {
  const userId = `u-${s.members.length + 1}`;
  const kind = by.kind === "agent" ? "agent" : "member";
  s.members.push({ userId, name: by.name, username: by.name.toLowerCase(), kind });
  const content = notes.map((n) => `- ${n}\n`).join("");
  const contentJson = markdown?.toDoc(content) ?? null;
  const page = notesPage(s, owner);
  if (page) {
    changeDoc(s, page, { content, contentJson }, userId);
  } else {
    const root =
      s.docs.find((d) => d.title === NOTES_ROOT && d.parentId === null) ??
      addDoc(s, { title: NOTES_ROOT }, userId);

    addDoc(s, { title: owner, parentId: root.id, content, contentJson }, userId);
  }

  return { id: userId, name: by.name, username: by.name.toLowerCase(), kind: by.kind };
}

const knowledgeSeed = (s: ItsaplanStore, markdown: Markdown | undefined): KnowledgeSeed => ({
  notesEdit: async (owner, notes, by) => editNotes(s, markdown, owner, notes, by),
  async issue() {
    return createIssue(s, s.members[0]!.userId, { title: "Linked", columnId: s.columns[0]!.id })
      .identifier;
  },
  async initiative() {
    const at = s.now();
    const id = 300 + s.initiatives.length + 1;
    s.initiatives.push({
      id,
      projectId: 1,
      title: "Planned",
      description: "",
      status: "planned",
      createdAt: at,
      updatedAt: at,
    });

    return String(id);
  },
  async doc(d) {
    const row = addDoc(
      s,
      {
        title: d.title,
        metadata: { path: d.path },
        content: d.body,
        contentJson: markdown?.toDoc(d.body) ?? null,
      },
      s.members[0]!.userId,
    );

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

export function createItsaplanFake({ markdown, ...opts }: FakeOptions = {}) {
  const { store, routes } = createItsaplanStandIn({
    ...opts,
    documents: markdown ? { quoteRange: markdown.quoteRange } : {},
  });

  const stub = createStubFetch([...forbidden, ...routes]);
  const { issues, activity, columns, labels, members, attachments, docs, docComments } = store;
  const { repositories, pullRequests, development, docIssues, customFields, fieldValues } = store;
  const { initiatives, docInitiatives } = store;
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
      repositories,
      pullRequests,
      development,
      docIssues,
      initiatives,
      docInitiatives,
      customFields,
      fieldValues,
    },
    trackerSeed: trackerSeed(store),
    knowledgeSeed: knowledgeSeed(store, markdown),
    project: { key: store.key, ref: store.ref },
    clock: store.now,
  };
}
