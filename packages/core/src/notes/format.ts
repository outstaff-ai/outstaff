import { createHash } from "node:crypto";
import type { Note } from "./types.js";

/** A list item at the top level: `- `, `* `, `+ ` or `1. `, indented by at most one space. */
const ITEM = /^ ?(?:[-*+]|\d+[.)])\s+(.*)$/;
const HEADING = /^\s{0,3}#/;

/** A note's text on one line, without surrounding space. */
export const normalizeNote = (text: string): string => text.replaceAll(/\s+/g, " ").trim();

/** A short id of a note, from its text: the same text has the same id wherever it is kept. */
export const noteId = (text: string): string =>
  createHash("sha256").update(normalizeNote(text)).digest("hex").slice(0, 8);

export const toNote = (text: string): Note => ({ id: noteId(text), text: normalizeNote(text) });

/** What a line of a notes text is: the start of a note, more of the current one, or the end of it. */
function lineKind(line: string): { start: string } | "more" | "end" {
  const item = ITEM.exec(line);
  if (item) {
    return { start: item[1] ?? "" };
  }

  return line.trim() === "" || HEADING.test(line) ? "end" : "more";
}

/**
 * The notes in a Markdown text, in order. Each top-level list item is a note, with the lines that follow it until a
 * blank line (nested items included); a paragraph outside a list is a note too. Headings are left out, and a note
 * that repeats an earlier one is dropped.
 */
export function parseNotes(markdown: string): string[] {
  const notes: string[] = [];
  let current: string[] = [];
  const end = () => {
    const text = normalizeNote(current.join(" "));
    if (text && !notes.includes(text)) {
      notes.push(text);
    }

    current = [];
  };

  for (const line of markdown.split(/\r?\n/)) {
    const kind = lineKind(line);
    if (kind === "more") {
      current.push(line);
      continue;
    }

    end();
    if (kind !== "end") {
      current.push(kind.start);
    }
  }

  end();
  return notes;
}

/** The notes as a Markdown list, one item each. */
export const renderNotes = (notes: readonly string[]): string =>
  notes.map((n) => `- ${normalizeNote(n)}\n`).join("");
