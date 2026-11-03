import {
  PortError,
  parseNotes,
  renderNotes,
  type KnowledgeNotes,
  type Member,
  type NotesOwner,
  type NotesPage,
} from "@outstaff/core";
import type {
  ApiDoc,
  ApiDocRevision,
  ApiDocRevisionContent,
  ApiDocSummary,
  ApiProject,
  Itsaplan,
} from "@outstaff/integration.shared.itsaplan";
import { mdToDoc } from "./markdown.js";

/** The public top-level page every agent's notes page sits under, one page per agent, titled with its name. */
export const NOTES_ROOT = "Agent notes";

/** A version whose author the API does not name; never trusted. */
const UNKNOWN: Member = { id: "unknown", name: "unknown", kind: "human" };

/** The oldest of the pages, so two made at once by a race always resolve to the same one. */
const oldest = (pages: ApiDocSummary[]) => pages.toSorted((a, b) => a.id - b.id)[0];

/**
 * Agents' notes as public Docs pages: `Agent notes/<name>`, created by (so owned by) the agent, so a human can read,
 * correct and comment on them. A version is used only when `NotesOwner.trusted` accepts its author; otherwise the
 * newest earlier version that it accepts, from the page's revisions.
 */
export function itsaplanNotes(api: Itsaplan): KnowledgeNotes {
  const docs = `${api.projectPath}/documents`;

  const locate = async (owner: NotesOwner) => {
    await api.ensureWorkspace();
    const all = await api.http.request<ApiDocSummary[]>("GET", docs);
    const root = oldest(all.filter((d) => d.title === NOTES_ROOT && !d.parentId));
    const page =
      root && oldest(all.filter((d) => d.parentId === root.id && d.title === owner.name));

    return { root, page };
  };

  const authorOf = (setup: ApiProject, userId: string | null | undefined): Member =>
    userId ? api.member(setup, userId) : UNKNOWN;

  const accepted = (owner: NotesOwner, setup: ApiProject, userId: string | null | undefined) =>
    Boolean(userId) && owner.trusted(authorOf(setup, userId));

  const pageOf = (doc: ApiDoc, notes: string[]): NotesPage => ({
    notes,
    version: String(doc.version),
    doc: { id: String(doc.id), title: doc.title, url: api.docUrl(String(doc.id)) },
  });

  /** The text of the newest version before the current one that a trusted author wrote, if any. */
  const lastAccepted = async (doc: ApiDoc, owner: NotesOwner, setup: ApiProject) => {
    const list = await api.http.request<ApiDocRevision[]>("GET", `${docs}/${doc.id}/revisions`);
    const hit = list
      .filter((r) => r.version < doc.version)
      .toSorted((a, b) => b.version - a.version)
      .find((r) => accepted(owner, setup, r.createdByUserId));

    return hit
      ? (
          await api.http.request<ApiDocRevisionContent>(
            "GET",
            `${docs}/${doc.id}/revisions/${hit.id}`,
          )
        ).content
      : "";
  };

  const create = (title: string, content: string, parentId?: number) =>
    api.http.request<ApiDoc>("POST", docs, {
      body: {
        title,
        content,
        contentJson: mdToDoc(content),
        isPrivate: false,
        ...(parentId === undefined ? {} : { parentId }),
      },
    });

  return {
    async read(owner) {
      const { page } = await locate(owner);
      if (!page) {
        return { notes: [] };
      }

      const [doc, setup] = await Promise.all([
        api.http.request<ApiDoc>("GET", `${docs}/${page.id}`),
        api.project(),
      ]);

      const by = doc.updatedByUserId ?? doc.createdByUserId;
      if (accepted(owner, setup, by)) {
        return pageOf(doc, parseNotes(doc.content ?? ""));
      }

      return {
        ...pageOf(doc, parseNotes(await lastAccepted(doc, owner, setup))),
        ignored: { author: authorOf(setup, by), at: doc.updatedAt, version: String(doc.version) },
      };
    },

    async write(owner, notes, version) {
      const content = renderNotes(notes);
      const { root, page } = await locate(owner);
      if ((version === undefined) !== (page === undefined)) {
        throw new PortError("conflict", `The notes of ${owner.name} changed; read them again.`);
      }

      if (!page) {
        const parent = root ?? (await create(NOTES_ROOT, ""));
        return pageOf(await create(owner.name, content, parent.id), notes);
      }

      const doc = await api.http.request<ApiDoc>("PATCH", `${docs}/${page.id}`, {
        body: { version: Number(version), content, contentJson: mdToDoc(content) },
      });

      return pageOf(doc, notes);
    },
  };
}
