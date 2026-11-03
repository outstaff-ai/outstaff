import type { DocChange, ItsaplanStore, NewDoc, StoredDoc } from "./types.js";

/** Saves the page's current version as a revision, by whoever wrote it. */
function saveRevision(s: ItsaplanStore, d: StoredDoc): void {
  s.docRevisions.push({
    id: ++s.counters.revision,
    documentId: d.id,
    version: d.version,
    title: d.title,
    createdByUserId: d.updatedByUserId,
    createdAt: d.updatedAt,
    content: d.content ?? "",
  });
}

/** Creates a page as `actor`, who owns it, and saves its first revision. */
export function addDoc(s: ItsaplanStore, b: NewDoc, actor: string): StoredDoc {
  const at = s.now();
  const row: StoredDoc = {
    id: ++s.counters.doc,
    parentId: b.parentId ?? null,
    title: b.title ?? "Untitled",
    metadata: b.metadata ?? {},
    version: 1,
    content: b.content ?? "",
    contentJson: b.contentJson ?? null,
    isPrivate: b.isPrivate ?? false,
    ownerUserId: actor,
    createdByUserId: actor,
    updatedByUserId: actor,
    createdAt: at,
    updatedAt: at,
  };

  s.docs.push(row);
  saveRevision(s, row);
  return row;
}

/** Changes a page as `actor`: a new version, saved as a revision. */
export function changeDoc(s: ItsaplanStore, d: StoredDoc, b: DocChange, actor: string): StoredDoc {
  for (const field of ["title", "content", "contentJson"] as const) {
    if (b[field] !== undefined) {
      Object.assign(d, { [field]: b[field] });
    }
  }

  d.version += 1;
  d.updatedAt = s.now();
  d.updatedByUserId = actor;
  saveRevision(s, d);
  return d;
}
