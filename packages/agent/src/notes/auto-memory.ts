import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { normalizeNote } from "@outstaff/core";

/** Larger files were not notes. */
export const MAX_FILE_BYTES = 256 * 1024;

/** Claude Code's index of its auto-memory files, not a memory of its own. */
const INDEX = "MEMORY.md";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const DESCRIPTION = /^description:\s*(.*)$/m;

/**
 * The note an auto-memory file holds: its text without the frontmatter, on one line, or the frontmatter's
 * description when there is no text. One file is one memory, so it becomes one note, not one per paragraph.
 */
export function autoMemoryNote(text: string): string | undefined {
  const front = FRONTMATTER.exec(text);
  const body = normalizeNote(front ? text.slice(front[0].length) : text);
  if (body) {
    return body;
  }

  const description = front ? DESCRIPTION.exec(front[1] ?? "")?.[1] : undefined;
  return normalizeNote((description ?? "").replace(/^(["'])(.*)\1$/, "$2")) || undefined;
}

/** The Markdown text of a file, or undefined when it is not a small text file. */
export async function textOf(file: string): Promise<string | undefined> {
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile() || info.size > MAX_FILE_BYTES) {
    return undefined;
  }

  const text = await readFile(file, "utf8");
  return text.includes("\0") ? undefined : text;
}

const names = (dir: string) =>
  readdir(dir)
    .catch(() => [] as string[])
    .then((n) => n.toSorted());

const isMemoryFile = (name: string) =>
  name !== INDEX && !name.startsWith(".") && name.endsWith(".md");

/** The note of one auto-memory file, when it is a small text file that holds one. */
async function noteOf(file: string): Promise<string | undefined> {
  const text = await textOf(file);
  return text === undefined ? undefined : autoMemoryNote(text);
}

/**
 * The notes in the files Claude Code's auto-memory kept under `<home>/.claude/projects/*\/memory/`, by project and
 * file name, without its index file. Each file is one note.
 */
export async function autoMemoryNotes(home: string): Promise<string[]> {
  const projects = join(home, ".claude", "projects");
  const notes: string[] = [];
  for (const project of await names(projects)) {
    const dir = join(projects, project, "memory");
    for (const name of (await names(dir)).filter(isMemoryFile)) {
      const note = await noteOf(join(dir, name));
      if (note && !notes.includes(note)) {
        notes.push(note);
      }
    }
  }

  return notes;
}
