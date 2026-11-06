import type { CanonicalStatus } from "#/ports/types.js";

/** A ticket's status, when it entered it, and the status it had before. */
interface StatusHistory {
  status?: CanonicalStatus | undefined;
  statusSince?: string | undefined;
  previousStatus?: CanonicalStatus | undefined;
}

/**
 * The status a ticket had at a time (ISO-8601): the one before its latest change for a time before that change, else
 * its status now. One change back is all a reader of the tracker sees; a time it cannot place gets the status now.
 */
export function statusAt(
  ticket: StatusHistory | undefined,
  at: string,
): CanonicalStatus | undefined {
  const { statusSince: since, previousStatus: before } = ticket ?? {};
  return since && before && Date.parse(at) < Date.parse(since) ? before : ticket?.status;
}
