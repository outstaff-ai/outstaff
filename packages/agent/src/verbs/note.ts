import { toNote, type Note, type NotesPage } from "@outstaff/core";
import { z } from "zod";
import {
  addNote,
  docOf,
  notesStore,
  removeNote,
  reportNotes,
  updateNote,
  type NoteChange,
} from "#/notes/index.js";
import { defineVerb, result } from "./define.js";
import type { AgentEnv, VerbContext, VerbResult } from "./types.js";

const id = z
  .string()
  .regex(/^[0-9a-f]{8}$/, "Use a note id as `ost note list` shows it, for example 3f9a2c1b.")
  .describe("Id of the note, as `ost note list` shows it.");

const text = z
  .string()
  .min(1)
  .max(1000)
  .describe("The note: one lasting lesson or preference, in one or two sentences with the reason.");

const noteLine = (n: Note) => `- [${n.id}] ${n.text}`;

const countLine = (n: number) => `You have ${n} ${n === 1 ? "note" : "notes"}.`;

/** Where the notes are, for the end of a verb's output. */
const whereLines = (page: NotesPage): string[] => (page.doc ? [`Your notes: ${page.doc.url}`] : []);

const links = (page: NotesPage) => (page.doc ? [page.doc.url] : []);

/** The line about a version of the notes that is not used, when there is one. */
function ignoredLines(page: NotesPage): string[] {
  const i = page.ignored;
  return i
    ? [
        `${i.author.name} changed your notes (version ${i.version}, ${i.at}). They are not you or a trusted human, so that change is not used: these are your notes before it. Review it on the page and keep what is right with \`ost note add\` or \`ost note update\`; your next change replaces it.`,
      ]
    : [];
}

const SAID: Record<NoteChange["change"], string> = {
  added: "Noted",
  updated: "Changed the note to",
  removed: "Removed the note",
};

/** The verb's answer to a change, after the office is told of it. */
async function changed(env: AgentEnv, ctx: VerbContext, c: NoteChange): Promise<VerbResult> {
  if (c.changed) {
    await reportNotes(env, {
      change: c.change,
      note: c.note.text,
      ...docOf(c.page),
      ...(ctx.workItemId ? { workItemId: ctx.workItemId } : {}),
    });
  }

  const line = c.changed
    ? `${SAID[c.change]}: ${noteLine(c.note)}`
    : `Already noted: ${noteLine(c.note)}`;

  return result(
    [line, countLine(c.page.notes.length), ...whereLines(c.page)],
    { change: c.change, changed: c.changed, note: c.note, ...docOf(c.page) },
    links(c.page),
  );
}

export const noteList = defineVerb({
  name: "note.list",
  summary: "List your notes.",
  description:
    "Lists your notes, the lasting lessons and preferences you keep across work items, with their ids. Each round starts with them already.",
  input: z.strictObject({}),
  args: [],
  examples: ["ost note list"],
  async run(env) {
    const store = notesStore(env);
    const page = await store.read();
    const notes = page.notes.map(toNote);
    return result(
      [
        ...(notes.length ? notes.map(noteLine) : ["You have no notes yet."]),
        ...ignoredLines(page),
        ...whereLines(page),
      ],
      {
        store: store.kind,
        notes,
        ...docOf(page),
        ...(page.ignored ? { ignored: page.ignored } : {}),
      },
      links(page),
    );
  },
});

export const noteAdd = defineVerb({
  name: "note.add",
  summary: "Add a note.",
  description:
    "Adds a lasting lesson or preference to your notes (see references/memory.md). A note you already have is not added twice.",
  input: z.strictObject({ text }),
  args: ["text"],
  examples: ['ost note add "Run pnpm test before pushing: CI does not run the slow suite."'],
  async run(env, input, ctx) {
    return changed(env, ctx, await addNote(notesStore(env), input.text));
  },
});

export const noteUpdate = defineVerb({
  name: "note.update",
  summary: "Change a note.",
  description: "Replaces the text of one of your notes, by its id. The id changes with the text.",
  input: z.strictObject({ id, text }),
  args: ["id", "text"],
  examples: ['ost note update 3f9a2c1b "Run pnpm test and pnpm lint before pushing."'],
  async run(env, input, ctx) {
    return changed(env, ctx, await updateNote(notesStore(env), input.id, input.text));
  },
});

export const noteRemove = defineVerb({
  name: "note.remove",
  summary: "Remove a note.",
  description: "Removes one of your notes, by its id, when it turns out wrong or outdated.",
  input: z.strictObject({ id }),
  args: ["id"],
  examples: ["ost note remove 3f9a2c1b"],
  async run(env, input, ctx) {
    return changed(env, ctx, await removeNote(notesStore(env), input.id));
  },
});

export const noteVerbs = [noteList, noteAdd, noteUpdate, noteRemove];
