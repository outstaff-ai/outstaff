import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PortError, parseNotes, renderNotes, type NotesPage } from "@outstaff/core";
import type { NotesStore } from "./types.js";

/** The file in `memory/` the volume store keeps the notes in. */
export const NOTES_FILE = "notes.md";

const versionOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

/** The notes as a Markdown list in `memory/notes.md` on the agent's volume; its version is a hash of the file. */
export function volumeNotes(dir: string): NotesStore {
  const file = join(dir, NOTES_FILE);
  const read = async (): Promise<NotesPage> => {
    const text = await readText(file);
    return text === undefined
      ? { notes: [] }
      : { notes: parseNotes(text), version: versionOf(text) };
  };

  return {
    kind: "volume",
    read,
    async write(notes, version) {
      if ((await read()).version !== version) {
        throw new PortError("conflict", "Your notes changed meanwhile; read them again.");
      }

      const text = renderNotes(notes);
      await mkdir(dir, { recursive: true });
      // A whole file or none: written beside it, then moved over it.
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, text);
      await rename(tmp, file);
      return { notes: parseNotes(text), version: versionOf(text) };
    },
  };
}
