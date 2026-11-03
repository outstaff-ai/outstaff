import type { NotesPage } from "@outstaff/core";
import type { NotesReport } from "#/verbs/office.types.js";
import type { AgentEnv } from "#/verbs/types.js";

/** The page of a report, when the notes are shown on one. */
export const docOf = (page: NotesPage): Pick<NotesReport, "doc"> =>
  page.doc ? { doc: page.doc } : {};

/** Tells the office about the notes. The change is made already: an office that refuses costs only a log line. */
export async function reportNotes(env: AgentEnv, report: NotesReport): Promise<void> {
  if (!env.office) {
    return;
  }

  try {
    await env.office.notesChanged(report);
  } catch (error) {
    env.log?.warn("could not tell the office about the notes", {
      change: report.change,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
