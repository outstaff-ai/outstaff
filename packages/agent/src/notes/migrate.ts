import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseNotes } from "@outstaff/core";
import type { AgentEnv } from "#/verbs/types.js";
import { MAX_NOTES } from "./change.js";
import { docOf, reportNotes } from "./report.js";
import { notesStore } from "./store.js";
import type { NotesStore } from "./types.js";

/** Larger files in `memory/` were not notes. */
const MAX_FILE_BYTES = 256 * 1024;

const isText = (name: string) => !name.startsWith(".") && !name.endsWith(".tmp");

/** The notes in the files of `memory/`, by file name; a file that is not text is left out. */
async function notesIn(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const notes: string[] = [];
  for (const name of names.filter(isText).toSorted()) {
    const file = join(dir, name);
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) {
      continue;
    }

    const text = await readFile(file, "utf8");
    if (!text.includes("\0")) {
      notes.push(...parseNotes(text).filter((n) => !notes.includes(n)));
    }
  }

  return notes;
}

/** The notes to move: those of the files in `memory/`, when the store has none yet. */
async function toMove(store: NotesStore, dir: string | undefined): Promise<string[]> {
  if (!dir || (await store.read()).version !== undefined) {
    return [];
  }

  return (await notesIn(dir)).slice(0, MAX_NOTES);
}

/**
 * On a start where the store has no notes yet, the files the agent kept in `memory/` before become its notes: the
 * volume store's file, or the knowledge base's page. The files are left in place. Never throws: an agent whose notes
 * cannot be moved starts without them, and the next start tries again.
 */
export async function migrateMemory(env: AgentEnv): Promise<void> {
  try {
    const store = notesStore(env);
    const notes = await toMove(store, env.layout?.memoryDir);
    if (notes.length === 0) {
      return;
    }

    const page = await store.write(notes, undefined);
    env.log?.info("moved the notes in memory/ to the notes store; the files stay", {
      store: store.kind,
      count: notes.length,
    });

    await reportNotes(env, { change: "migrated", count: notes.length, ...docOf(page) });
  } catch (error) {
    env.log?.warn("could not move the notes in memory/ to the notes store", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
