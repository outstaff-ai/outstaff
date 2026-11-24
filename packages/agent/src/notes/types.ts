import type { IgnoredNotesEdit, Note, NotesPage } from "@outstaff/core";
import type { LessonCheck } from "@outstaff/protocol";

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

/**
 * The lesson check of one round: when its feedback carries a comment or review by a trusted human and no note changed,
 * `ost handback` refuses once and asks for the lesson, or for `--nothing-to-keep`.
 */
export interface Lessons {
  /** A note was added, changed or removed in the round. */
  noted(): void;

  /** At `ost handback`: the refusal to give, once, or undefined to take the hand-back. */
  check(nothingToKeep: boolean): string | undefined;

  /** What the round did about it, for the hand-back; undefined when no trusted human commented or reviewed. */
  outcome(): LessonCheck | undefined;
}
