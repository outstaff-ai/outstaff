import { PortError, type Doc, type DocIssueLinkOutcome, type IssueDoc } from "#/ports/index.js";
import type { FakeDocLinks } from "./types.js";

/**
 * Links from documents to targets the fake has no tracker for (tickets, initiatives): the seed adds the targets, and a
 * document is linked on one once.
 */
export function fakeDocLinks(what: string, find: (id: string) => Doc, author: string) {
  const known = new Set<string>();
  const links: FakeDocLinks = new Map();
  const need = (target: string) => {
    if (!known.has(target)) {
      throw new PortError("not_found", `${what} ${target} not found.`);
    }

    return links.get(target) ?? [];
  };

  return {
    known,
    links,

    async link(docId: string, target: string): Promise<DocIssueLinkOutcome> {
      const doc = find(docId);
      const list = need(target);
      if (list.some((l) => l.doc === doc.id)) {
        return "already_linked";
      }

      links.set(target, [...list, { doc: doc.id, by: author }]);
      return "linked";
    },

    async docs(target: string): Promise<IssueDoc[]> {
      return need(target).map((l) => ({ id: l.doc, title: find(l.doc).title }));
    },
  };
}
