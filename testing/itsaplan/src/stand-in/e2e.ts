import { docsState, ticketsState } from "./e2e-state.js";
import type { ItsaplanE2eOptions } from "./e2e.types.js";
import {
  assignIssue,
  commentDoc,
  commentIssue,
  createIssue,
  docById,
  issueByKey,
  memberNamed,
  touch,
} from "./model.js";
import { createItsaplanStandIn } from "./stand-in.js";
import type { ItsaplanStore } from "./types.js";

/** Real time, strictly increasing, so the feed's order is the order things happened in. */
function realClock(): () => string {
  let tick = 0;
  return () => new Date(Date.now() + ++tick).toISOString();
}

const columnNamed = (s: ItsaplanStore, name: string) =>
  s.columns.find((c) => c.name.toLowerCase() === name.toLowerCase());

const member = (s: ItsaplanStore, username: string) => {
  const m = memberNamed(s, username);
  if (!m) {
    throw new Error(`No member ${username}.`);
  }

  return m;
};

/** What the test driver does in Its a Plan as the human of the team. */
function controls(s: ItsaplanStore, human: string) {
  return {
    /**
     * A person creates a ticket in a column (by status name). With `assignee`, the ticket is created already
     * assigned: one `created` item, no `assignee` item. `actor` (a username) creates it as someone else than the
     * human, for example an agent assigning itself a piece of its own work.
     */
    createTicket(
      title: string,
      description: string,
      status: string,
      assignee?: string,
      actor?: string,
    ) {
      const col = columnNamed(s, status);
      if (!col) {
        throw new Error(`No column ${status}.`);
      }

      const who = assignee === undefined ? undefined : member(s, assignee);
      return createIssue(s, actor === undefined ? human : member(s, actor).userId, {
        title,
        description,
        columnId: col.id,
        ...(who ? { assigneeUserId: who.userId } : {}),
      }).identifier;
    },

    assignTicket(keyName: string, username: string) {
      const issue = issueByKey(s, keyName);
      const who = memberNamed(s, username);
      if (!issue || !who) {
        throw new Error(`Cannot assign ${keyName} to ${username}.`);
      }

      assignIssue(s, issue, human, who.userId);
      touch(s, issue);
    },

    /** A person comments on a ticket. */
    commentTicket(keyName: string, body: string) {
      const issue = issueByKey(s, keyName);
      if (!issue) {
        throw new Error(`No ticket ${keyName}.`);
      }

      commentIssue(s, issue, human, body);
    },

    /** A person comments on a document (a reply when `parentId` is given). */
    commentDoc(id: string, body: string, quote: string, parentId?: string) {
      const d = docById(s, id);
      if (!d) {
        throw new Error(`No document ${id}.`);
      }

      const parent = parentId ?? null;
      return commentDoc(s, human, {
        documentId: d.id,
        parentId: parent,
        body,
        quote,
        from: null,
        to: null,
      }).id;
    },
  };
}

/**
 * The stand-in as the end-to-end stubs serve it: routes under `/tracker`, an actor per API key, real time,
 * comments taken as they come, whole pages in the document listing, and the controls the test driver acts through.
 */
export function createItsaplanE2e(opts: ItsaplanE2eOptions) {
  const { store, routes, dispatch } = createItsaplanStandIn({
    now: realClock(),
    keys: opts.keys,
    members: opts.members,
    columns: opts.columns,
    projectKey: opts.projectKey,
    teamRef: opts.teamRef,
    basePath: "/tracker",
    documents: { listing: "all" },
    ...(opts.repositories ? { repositories: opts.repositories } : {}),
    ...(opts.pullRequests ? { pullRequests: opts.pullRequests } : {}),
  });

  const human = memberNamed(store, opts.human)!.userId;
  return {
    routes,
    dispatch,
    ...controls(store, human),

    /** Public ids of the attachments the agents downloaded. */
    served: () => store.served,
    docs: () => docsState(store),
    state: () => ticketsState(store),
  };
}
