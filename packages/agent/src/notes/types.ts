import type { IgnoredNotesEdit, Note, NotesPage } from "@outstaff/core";

/** Where an agent's notes are kept, chosen by `memory.store`: files on its volume, or the knowledge base. */
export interface NotesStore {
  kind: "volume" | "knowledge";
  read(): Promise<NotesPage>;

  /** Replaces the notes; `version` is the one read, and a stale one is a `conflict`. */
  write(notes: string[], version: string | undefined): Promise<NotesPage>;
}

/** What one `ost note` change did. */
export interface NoteChange {
  change: "added" | "updated" | "removed";
  note: Note;

  /** The notes after the change. */
  page: NotesPage;

  /** False when nothing had to change: the note was there already. */
  changed: boolean;
}

/** The notes a round starts with, as the prompt shows them. */
export interface RoundNotes {
  notes: Note[];
  store: NotesStore["kind"];
  doc?: NotesPage["doc"];
  ignored?: IgnoredNotesEdit;

  /** Why the notes could not be read; the round runs without them. */
  error?: string;
}

/** Reads the notes a round starts with. */
export type NotesReader = (workItemId: string) => Promise<RoundNotes>;
