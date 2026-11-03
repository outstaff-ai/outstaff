import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseNotes } from "@outstaff/core";
import type { AgentEnv } from "#/verbs/types.js";
import { autoMemoryNotes, textOf } from "./auto-memory.js";
import { addNotes, MAX_NOTES } from "./change.js";
import { docOf, reportNotes } from "./report.js";
import { notesStore } from "./store.js";
import type { NotesStore } from "./types.js";

/** In `memory/`: Claude Code's auto-memory files were moved to the notes store, so they are not moved again. */
export const AUTO_MEMORY_MOVED = ".auto-memory-moved";

const isText = (name: string) => !name.startsWith(".") && !name.endsWith(".tmp");

/** The notes in the files of `memory/`, by file name; a file that is not text is left out. */
async function notesIn(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const notes: string[] = [];
  for (const name of names.filter(isText).toSorted()) {
    const text = await textOf(join(dir, name));
    if (text !== undefined) {
      notes.push(...parseNotes(text).filter((n) => !notes.includes(n)));
    }
  }

  return notes;
}

/** The notes of the files in `memory/` go to the store when it has none yet. */
async function moveMemoryFiles(env: AgentEnv, store: NotesStore, dir: string): Promise<void> {
  if ((await store.read()).version !== undefined) {
    return;
  }

  const notes = (await notesIn(dir)).slice(0, MAX_NOTES);
  if (notes.length === 0) {
    return;
  }

  const page = await store.write(notes, undefined);
  env.log?.info("moved the notes in memory/ to the notes store; the files stay", {
    store: store.kind,
    count: notes.length,
  });

  await reportNotes(env, { change: "migrated", count: notes.length, ...docOf(page) });
}

/**
 * Once per agent, the files Claude Code's own auto-memory kept are added to the store, after the notes there. The
 * runtime keeps that memory off now; these are what it wrote before.
 */
async function moveAutoMemory(
  env: AgentEnv,
  store: NotesStore,
  layout: { home: string; memoryDir: string },
): Promise<void> {
  const marker = join(layout.memoryDir, AUTO_MEMORY_MOVED);
  if (existsSync(marker)) {
    return;
  }

  const { page, added } = await addNotes(store, await autoMemoryNotes(layout.home));
  await mkdir(layout.memoryDir, { recursive: true });
  await writeFile(marker, `${new Date().toISOString()}\n`);
  if (added === 0) {
    return;
  }

  env.log?.info("moved Claude Code's auto-memory to the notes store; the files stay", {
    store: store.kind,
    count: added,
  });

  await reportNotes(env, { change: "migrated", count: added, ...docOf(page) });
}

/**
 * Moves the memory an agent kept before its notes into the notes store: the files in `memory/`, on a start where the
 * store has no notes yet, then, once, Claude Code's auto-memory files. The files are left in place. Never throws: an
 * agent whose notes cannot be moved starts without them, and the next start tries again.
 */
export async function migrateMemory(env: AgentEnv): Promise<void> {
  try {
    const store = notesStore(env);
    if (!env.layout) {
      return;
    }

    await moveMemoryFiles(env, store, env.layout.memoryDir);
    await moveAutoMemory(env, store, env.layout);
  } catch (error) {
    env.log?.warn("could not move the agent's earlier memory to the notes store", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
