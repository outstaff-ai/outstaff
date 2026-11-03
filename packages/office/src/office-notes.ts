import type { Logger } from "@outstaff/core";
import type { AgentNotesDesk } from "./protocol/index.js";
import type { WorkState } from "./workstate/index.js";

/**
 * What agents report about their notes (`notes_changed`): every change is logged, and a version by someone the agent
 * does not trust at warn. A notes page in the knowledge base is recorded as the agent's document, so comments people
 * leave on it reach the agent like comments on any document it wrote.
 */
export function officeNotes(deps: { workState: WorkState; log: Logger }): AgentNotesDesk {
  const { workState, log } = deps;

  return {
    async changed(person, report) {
      if (report.doc) {
        await workState.linkDoc({ ...report.doc, author: person });
      }

      const fields = {
        person,
        change: report.change,
        ...(report.note === undefined ? {} : { note: report.note }),
        ...(report.count === undefined ? {} : { count: report.count }),
        ...(report.doc ? { doc: report.doc.id, url: report.doc.url } : {}),
        ...(report.workItemId ? { workItemId: report.workItemId } : {}),
      };

      if (report.edit) {
        log.warn(
          `notes of ${person}: version ${report.edit.version} by ${report.edit.author} is not used, as ${report.edit.author} is not trusted`,
          {
            ...fields,
            author: report.edit.author,
            at: report.edit.at,
            version: report.edit.version,
          },
        );

        return;
      }

      log.info(`notes of ${person}: ${report.change}`, fields);
    },
  };
}
