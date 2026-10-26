import type { KnowledgeSeed } from "../contracts/seeds.js";
import { PortError } from "../ports/index.js";
import type { Doc, DocComment, DocEvent, Knowledge } from "../ports/index.js";
import { steppingClock } from "./util.js";

export interface FakeKnowledgeOptions {
  baseUrl?: string;
  author?: string;
  now?: () => Date;
}

export interface FakeKnowledge extends Knowledge {
  seed: KnowledgeSeed;
}

export function createFakeKnowledge(opts: FakeKnowledgeOptions = {}): FakeKnowledge {
  const base = (opts.baseUrl ?? "https://docs.acme.example").replace(/\/+$/, "");
  const now = opts.now ?? steppingClock();
  const author = opts.author ?? "fake-knowledge";
  const docs = new Map<string, Doc>();
  const comments = new Map<string, DocComment>();
  let counter = 0;
  let commentCounter = 0;

  const find = (idOrPath: string): Doc => {
    const doc = docs.get(idOrPath) ?? [...docs.values()].find((d) => d.path === idOrPath);
    if (!doc) {
      throw new PortError("not_found", `Document ${idOrPath} not found.`);
    }

    return doc;
  };

  const needComment = (id: string): DocComment => {
    const c = comments.get(id);
    if (!c) {
      throw new PortError("not_found", `Comment ${id} not found.`);
    }

    return c;
  };

  const links = { doc: (id: string) => `${base}/d/${encodeURIComponent(id)}` };
  const addComment = (
    docId: string,
    c: { body: string; anchorText?: string; parentId?: string },
  ): DocComment => {
    const created: DocComment = {
      id: `c${++commentCounter}`,
      docId,
      author,
      body: c.body,
      resolved: false,
      at: now().toISOString(),
    };

    if (c.anchorText !== undefined) {
      created.anchorText = c.anchorText;
    }

    if (c.parentId !== undefined) {
      created.parentId = c.parentId;
    }

    comments.set(created.id, created);
    return structuredClone(created);
  };

  const create: Knowledge["create"] = async ({ path, title, body }) => {
    if ([...docs.values()].some((d) => d.path === path)) {
      throw new PortError("conflict", `A document already exists at ${path}.`);
    }

    const id = `doc-${++counter}`;
    const doc: Doc = {
      id,
      path,
      title,
      body,
      url: links.doc(id),
      version: "1",
      updatedAt: now().toISOString(),
    };

    docs.set(id, doc);
    return structuredClone(doc);
  };

  return {
    links,
    seed: {
      doc: create,
      forbiddenCall: () => Promise.reject(new PortError("forbidden", "Forbidden.")),
    },
    async search(q, limit) {
      const needle = q.toLowerCase();
      const hits = [...docs.values()].filter((d) =>
        `${d.title}\n${d.body}`.toLowerCase().includes(needle),
      );

      return structuredClone(hits.slice(0, limit));
    },
    async get(idOrPath) {
      return structuredClone(find(idOrPath));
    },
    create,
    async update(id, patch) {
      const doc = find(id);
      if (patch.baseVersion !== undefined && patch.baseVersion !== doc.version) {
        throw new PortError(
          "conflict",
          `Document ${id} changed since version ${patch.baseVersion}.`,
        );
      }

      if (patch.title !== undefined) {
        doc.title = patch.title;
      }

      if (patch.body !== undefined) {
        doc.body = patch.body;
      }

      doc.version = String(Number(doc.version) + 1);
      doc.updatedAt = now().toISOString();
      return structuredClone(doc);
    },
    async comments(id) {
      const doc = find(id);
      return structuredClone([...comments.values()].filter((c) => c.docId === doc.id));
    },
    async comment(id, c) {
      return addComment(find(id).id, c);
    },
    async reply(commentId, body) {
      const parent = needComment(commentId);
      return addComment(parent.docId, { body, parentId: parent.id });
    },
    async resolve(commentId) {
      needComment(commentId).resolved = true;
    },
    async events(ids, cursor) {
      const after = cursor === undefined ? undefined : (JSON.parse(cursor) as { since: string });
      const wanted = new Set(ids.map((id) => find(id).id));
      const all = [...comments.values()]
        .filter((c) => wanted.has(c.docId))
        .toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at));

      const events = (
        after ? all.filter((c) => Date.parse(c.at) > Date.parse(after.since)) : []
      ).map((c): DocEvent => {
        const doc = docs.get(c.docId)!;
        return {
          externalId: `fake:${c.id}`,
          type: "commented",
          doc: doc.id,
          title: doc.title,
          url: doc.url,
          actor: { id: c.author, name: c.author, kind: "human" },
          at: c.at,
          data: {
            commentId: c.id,
            ...(c.parentId ? { parentId: c.parentId } : {}),
            ...(c.anchorText ? { anchorText: c.anchorText } : {}),
            body: c.body,
          },
        };
      });

      const newest = Math.max(
        after ? Date.parse(after.since) : Number.NEGATIVE_INFINITY,
        ...all.map((c) => Date.parse(c.at)),
      );

      return {
        events,
        cursor: JSON.stringify({
          since: new Date(Number.isFinite(newest) ? newest : now().getTime()).toISOString(),
        }),
      };
    },
  };
}
