import { toNote, type NotesPage } from "@outstaff/core";
import type { AgentEnv } from "#/verbs/types.js";
import { docOf, reportNotes } from "./report.js";
import { notesStore } from "./store.js";
import type { NotesReader, NotesStore } from "./types.js";

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Reads the agent's notes at the start of each round. A version by someone the agent does not trust is logged and
 * reported to the office once per version; every round's prompt still says it is not used. Notes that cannot be read
 * are logged, and the round runs without them.
 */
export function createNotesReader(env: AgentEnv): NotesReader {
  const told = new Set<string>();
  const kind = (): NotesStore["kind"] => env.team.memory?.store ?? "volume";

  const flag = async (page: NotesPage, workItemId: string) => {
    const ignored = page.ignored;
    if (!ignored || told.has(ignored.version)) {
      return;
    }

    told.add(ignored.version);
    env.log?.warn("a version of the notes by someone not trusted is not used", {
      author: ignored.author.name,
      version: ignored.version,
    });

    await reportNotes(env, {
      change: "edit_ignored",
      edit: { author: ignored.author.name, at: ignored.at, version: ignored.version },
      ...docOf(page),
      workItemId,
    });
  };

  return async (workItemId) => {
    try {
      const store = notesStore(env);
      const page = await store.read();
      await flag(page, workItemId);
      return {
        notes: page.notes.map(toNote),
        store: store.kind,
        ...(page.doc ? { doc: page.doc } : {}),
        ...(page.ignored ? { ignored: page.ignored } : {}),
      };
    } catch (error) {
      env.log?.warn("could not read the notes", { workItemId, error: reason(error) });
      return { notes: [], store: kind(), error: reason(error) };
    }
  };
}
