import { PortError, normalizeNote, noteId, toNote, type NotesPage } from "@outstaff/core";
import type { NoteChange, NotesStore } from "./types.js";

/** Notes are meant to stay small: every one is read into every round. */
export const MAX_NOTES = 100;

const conflict = (e: unknown) => e instanceof PortError && e.code === "conflict";

/**
 * Reads the notes, changes them with `edit` and writes them from the version read; a write that lost a race reads
 * and changes them once more. `edit` returns the new notes, or undefined when nothing has to change.
 */
async function apply(
  store: NotesStore,
  edit: (notes: string[]) => string[] | undefined,
): Promise<{ page: NotesPage; changed: boolean }> {
  for (let attempt = 1; ; attempt++) {
    const page = await store.read();
    const next = edit(page.notes);
    if (!next) {
      return { page, changed: false };
    }

    try {
      return { page: await store.write(next, page.version), changed: true };
    } catch (error) {
      if (attempt > 1 || !conflict(error)) {
        throw error;
      }
    }
  }
}

function indexOf(notes: string[], id: string): number {
  const i = notes.findIndex((n) => noteId(n) === id);
  if (i < 0) {
    throw new PortError("not_found", `No note ${id}; \`ost note list\` shows the ids.`);
  }

  return i;
}

const needText = (text: string) => {
  const note = normalizeNote(text);
  if (!note) {
    throw new PortError("invalid", "A note needs some text.");
  }

  return note;
};

export async function addNote(store: NotesStore, text: string): Promise<NoteChange> {
  const note = needText(text);
  const done = await apply(store, (notes) => {
    if (notes.includes(note)) {
      return undefined;
    }

    if (notes.length >= MAX_NOTES) {
      throw new PortError(
        "invalid",
        `You have ${MAX_NOTES} notes, the most you can keep. Remove or merge some first.`,
      );
    }

    return [...notes, note];
  });

  return { change: "added", note: toNote(note), ...done };
}

export async function updateNote(store: NotesStore, id: string, text: string): Promise<NoteChange> {
  const note = needText(text);
  const done = await apply(store, (notes) => {
    const i = indexOf(notes, id);
    return notes[i] === note
      ? undefined
      : notes.with(i, note).filter((n, j) => j === i || n !== note);
  });

  return { change: "updated", note: toNote(note), ...done };
}

export async function removeNote(store: NotesStore, id: string): Promise<NoteChange> {
  let removed = "";
  const done = await apply(store, (notes) => {
    const i = indexOf(notes, id);
    removed = notes[i]!;
    return notes.toSpliced(i, 1);
  });

  return { change: "removed", note: toNote(removed), ...done };
}
