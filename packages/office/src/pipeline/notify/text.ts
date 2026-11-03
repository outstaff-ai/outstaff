import type { NoticeDeskOptions } from "./notify.types.js";

/**
 * What is needed, for a notice with no hand-back text (an agent gave a blocked ticket to a human itself, as a PM does
 * when it cannot unblock it): the agent's latest comment on the ticket, which says what it needs. None when the
 * tracker cannot be read.
 */
export async function escalationText(
  opts: Pick<NoticeDeskOptions, "tracker" | "team" | "logger">,
  as: string,
  ticket: string,
): Promise<string | undefined> {
  const identity = opts.team.people.find((p) => p.handle === as)?.identities?.tracker ?? as;
  try {
    const comments = (await opts.tracker?.listComments(ticket)) ?? [];
    return comments
      .filter((c) => c.author.id === identity || c.author.username === identity)
      .toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at))
      .at(-1)?.body;
  } catch (error) {
    opts.logger.warn("notify: could not read the ticket's comments", {
      ticket,
      error: String(error),
    });

    return undefined;
  }
}
