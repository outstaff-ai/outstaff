import { PortError } from "#/ports/index.js";
import type { Member, NotesOwner, NotesPage } from "#/ports/index.js";
import type { FakeNotes } from "./types.js";

/** One saved version of an agent's notes, and who wrote it. */
interface FakeNotesVersion {
  notes: string[];
  author: Member;
  at: string;
}

/** Notes kept in memory, one list of versions per owner; the caller writes as `self`. */
export function createFakeNotes(
  self: Member,
  now: () => Date,
  url: (id: string) => string,
): FakeNotes {
  const pages = new Map<string, FakeNotesVersion[]>();

  const edit = (owner: string, notes: string[], author: Member) => {
    const versions = pages.get(owner) ?? [];
    versions.push({ notes: [...notes], author, at: now().toISOString() });
    pages.set(owner, versions);
  };

  const read = async (owner: NotesOwner): Promise<NotesPage> => {
    const versions = pages.get(owner.name);
    if (!versions) {
      return { notes: [] };
    }

    const current = versions.length;
    const id = `notes-${encodeURIComponent(owner.name)}`;
    const used = versions.findLastIndex((v) => owner.trusted(v.author));
    const ignored = versions.at(-1)!;
    return {
      notes: used < 0 ? [] : [...versions[used]!.notes],
      version: String(current),
      doc: { id, title: owner.name, url: url(id) },
      ...(used === current - 1
        ? {}
        : { ignored: { author: ignored.author, at: ignored.at, version: String(current) } }),
    };
  };

  return {
    edit,
    notes: {
      read,
      async write(owner, notes, version) {
        const current = pages.get(owner.name)?.length;
        if (version !== (current === undefined ? undefined : String(current))) {
          throw new PortError("conflict", `The notes of ${owner.name} changed; read them again.`);
        }

        edit(owner.name, notes, self);
        return read(owner);
      },
    },
  };
}
