import {
  PortError,
  type AdapterContext,
  type Doc,
  type DocComment,
  type Knowledge,
} from "@outstaff/core";
import {
  createClient,
  type ClientDeps,
  type Itsaplan,
} from "@outstaff/integration.shared.itsaplan";
import type { KnowledgeOptions } from "./types.js";
import { commentId, parseCommentId } from "./comment-ids.js";
import { find, pathOf, segments } from "./doc-tree.js";
import { readDocEvents } from "./events.js";
import { mdToDoc } from "./markdown.js";
import { findRange, plainText } from "./text-range.js";
import type {
  ApiDoc,
  ApiDocComment,
  ApiDocSummary,
  PmNode,
} from "@outstaff/integration.shared.itsaplan";
import type { Tree } from "./types.js";

const NUMERIC = /^\d+$/;
const QUOTE_FALLBACK = 80;

export function createItsaplanKnowledge(
  ctx: AdapterContext<KnowledgeOptions>,
  deps: ClientDeps = {},
): Promise<Knowledge> {
  return createClient(ctx, deps).then((api) => buildKnowledge(api, ctx.now));
}

function buildKnowledge(api: Itsaplan, now: () => Date): Knowledge {
  const docs = `${api.projectPath}/documents`;

  const list = async (q?: string) => {
    await api.ensureWorkspace();
    return api.http.request<ApiDocSummary[]>("GET", docs, { query: q ? { q } : {} });
  };

  const treeOf = async (): Promise<Tree> => {
    const items = await list();
    return { items, byId: new Map(items.map((d) => [d.id, d])) };
  };

  const read = async (id: number | string) => {
    await api.ensureWorkspace();
    return api.http.request<ApiDoc>("GET", `${docs}/${id}`);
  };

  const toDoc = (d: ApiDoc, path: string): Doc => ({
    id: String(d.id),
    path,
    title: d.title,
    body: d.content ?? "",
    url: api.docUrl(String(d.id)),
    version: String(d.version),
    updatedAt: d.updatedAt,
  });

  const idOf = async (idOrPath: string): Promise<number> => {
    if (NUMERIC.test(idOrPath)) {
      return Number(idOrPath);
    }

    const hit = find(await treeOf(), idOrPath);
    if (!hit) {
      throw new PortError("not_found", `No document at "${idOrPath}".`);
    }

    return hit.id;
  };

  const full = async (id: number): Promise<Doc> => {
    const [doc, tree] = await Promise.all([read(id), treeOf()]);
    return toDoc(doc, pathOf(doc, tree.byId));
  };

  const toComment = (docId: number, c: ApiDocComment): DocComment => ({
    id: commentId(docId, c.id),
    docId: String(docId),
    author: c.authorName ?? "unknown",
    body: c.body,
    ...(c.quote ? { anchorText: c.quote } : {}),
    ...(c.parentId ? { parentId: commentId(docId, c.parentId) } : {}),
    resolved: Boolean(c.resolvedAt),
    at: c.createdAt,
  });

  const threads = async (docId: number) =>
    (await api.http.request<ApiDocComment[]>("GET", `${docs}/${docId}/comments`)).map((c) =>
      toComment(docId, c),
    );

  const created = async (docId: number, id: string): Promise<DocComment> => {
    const found = (await threads(docId)).find((c) => c.id === commentId(docId, id));
    if (!found) {
      throw new PortError("unavailable", `Comment ${id} was created but could not be read back.`);
    }

    return found;
  };

  /** Inline comments need the editor JSON; a page written as markdown only gets it on first comment. */
  const withEditorJson = async (docId: number): Promise<{ doc: ApiDoc; json: PmNode }> => {
    let doc = await read(docId);
    if (doc.contentJson) {
      return { doc, json: doc.contentJson };
    }

    const json = mdToDoc(doc.content ?? "");
    doc = await api.http.request<ApiDoc>("PATCH", `${docs}/${docId}`, {
      body: { version: doc.version, content: doc.content ?? "", contentJson: json },
    });

    return { doc, json };
  };

  return {
    links: {
      doc: (id) => api.docUrl(id),
      comment: (docId, id) => api.docCommentUrl(docId, id),
    },

    async get(idOrPath) {
      return full(await idOf(idOrPath));
    },

    async search(query, limit = 20) {
      const tree = await treeOf();
      const hits = new Map<number, ApiDocSummary>();
      for (const d of await list(query)) {
        hits.set(d.id, d);
      }

      for (const d of tree.items) {
        if (d.title.toLowerCase().includes(query.toLowerCase())) {
          hits.set(d.id, d);
        }
      }

      const picked = [...hits.values()].slice(0, limit);
      return Promise.all(
        picked.map(async (d) =>
          toDoc(await read(d.id), pathOf(tree.byId.get(d.id) ?? d, tree.byId)),
        ),
      );
    },

    async create({ path, title, body }) {
      const parts = segments(path);
      if (parts.length === 0 || title.includes("/")) {
        throw new PortError(
          "invalid",
          "A document needs a path, and its title cannot contain '/'.",
        );
      }

      const tree = await treeOf();
      if (find(tree, path)) {
        throw new PortError("conflict", `A document already exists at "${parts.join("/")}".`);
      }

      let parentId: number | undefined;
      for (let i = 1; i < parts.length; i++) {
        const prefix = parts.slice(0, i).join("/");
        let parent = find(tree, prefix);
        if (!parent) {
          parent = await api.http.request<ApiDoc>("POST", docs, {
            body: {
              title: parts[i - 1],
              content: "",
              contentJson: mdToDoc(""),
              metadata: { path: prefix },
              ...(parentId === undefined ? {} : { parentId }),
            },
          });

          tree.items.push(parent);
          tree.byId.set(parent.id, parent);
        }

        parentId = parent.id;
      }

      const made = await api.http.request<ApiDoc>("POST", docs, {
        body: {
          title,
          content: body,
          contentJson: mdToDoc(body),
          metadata: { path: parts.join("/") },
          ...(parentId === undefined ? {} : { parentId }),
        },
      });

      return toDoc(made, parts.join("/"));
    },

    async update(id, patch) {
      const docId = await idOf(id);
      const current = patch.baseVersion === undefined ? await read(docId) : undefined;
      const body: Record<string, unknown> = {
        version: Number(patch.baseVersion ?? current?.version),
      };

      if (patch.title !== undefined) {
        if (patch.title.includes("/")) {
          throw new PortError("invalid", "A title cannot contain '/'.");
        }

        body["title"] = patch.title;
      }

      if (patch.body !== undefined) {
        // Always both, so the page stays commentable.
        body["content"] = patch.body;
        body["contentJson"] = mdToDoc(patch.body);
      }

      const updated = await api.http.request<ApiDoc>("PATCH", `${docs}/${docId}`, { body });
      return toDoc(updated, pathOf(updated, (await treeOf()).byId));
    },

    comments(id) {
      return idOf(id).then(threads);
    },

    async comment(id, { body, anchorText }) {
      const docId = await idOf(id);
      const { doc, json } = await withEditorJson(docId);
      const quote = anchorText ?? plainText(json)[0]?.slice(0, QUOTE_FALLBACK);
      if (!quote) {
        throw new PortError("invalid", "The document has no text to anchor a comment to.");
      }

      const range = findRange(json, quote);
      if (!range) {
        throw new PortError(
          "invalid",
          "anchorText must be inside one paragraph of the document, copied exactly (formatting characters are not part of it).",
        );
      }

      const made = await api.http.request<{ id: string }>("POST", `${docs}/${docId}/comments`, {
        body: { body, quote, from: range[0], to: range[1], version: doc.version },
      });

      return created(docId, made.id);
    },

    async reply(id, body) {
      const parent = parseCommentId(id);
      const doc = await read(parent.docId);
      const made = await api.http.request<{ id: string }>(
        "POST",
        `${docs}/${parent.docId}/comments`,
        { body: { body, parentId: parent.id, version: doc.version } },
      );

      return created(parent.docId, made.id);
    },

    async resolve(id) {
      const target = parseCommentId(id);
      await api.http.request("PATCH", `${docs}/${target.docId}/comments/${target.id}`, {
        body: { resolved: true },
      });
    },

    async events(ids, cursor) {
      return readDocEvents({ api, docs, idOf, read, now }, ids, cursor);
    },
  };
}
