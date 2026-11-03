import type { RoundNotes } from "#/notes/types.js";
import type { DocPath } from "./prompt.types.js";

/** Where the notes are kept, in words. */
const WHERE: Record<RoundNotes["store"], string> = {
  volume: "on your volume",
  knowledge: "in the knowledge base",
};

function ignoredLine(notes: RoundNotes): string[] {
  const i = notes.ignored;
  if (!i) {
    return [];
  }

  const page = notes.doc ? ` (${notes.doc.url})` : "";
  return [
    `${i.author.name} changed your notes${page} at ${i.at}, as version ${i.version}. They are not you or a trusted human, so that change is not used: these are your notes from before it. Review the change on the page and keep what is right with \`ost note add\` or \`ost note update\`; your next change to your notes replaces it.`,
  ];
}

/** The agent's notes, read at the start of the round, or why they could not be read. */
export function notesLines(notes: RoundNotes | undefined, doc: DocPath): string[] {
  if (!notes) {
    return [];
  }

  if (notes.error) {
    return ["", `Your notes could not be read (${notes.error}). Carry on without them.`];
  }

  const head = `Your notes, kept ${WHERE[notes.store]} across work items. Change them only with \`ost note\`, as ${doc("references/memory.md")} says.`;
  return [
    "",
    notes.notes.length ? `${head} They are:` : `${head} You have none yet.`,
    ...notes.notes.map((n) => `- [${n.id}] ${n.text}`),
    ...ignoredLine(notes),
  ];
}
