import { PortError, type Issue, type Tracker } from "@outstaff/core";

const CLOSED = new Set(["done", "canceled"]);

/** The tickets named to block the new one, read before anything is written: an unknown key refuses the call. */
export const blockerIssues = (tracker: Tracker, keys: string[] | undefined): Promise<Issue[]> =>
  Promise.all([...new Set(keys ?? [])].map((k) => tracker.getIssue(k)));

/** The keys of the blockers still open (not done or canceled): with any, the new ticket starts blocked, from a chat session or not. */
export const openBlockerKeys = (blockers: Issue[]): string[] =>
  blockers.filter((b) => !CLOSED.has(b.status.canonical ?? "")).map((b) => b.key);

/** The open blockers the new ticket waits on: none unless it started blocked (a backlog ticket does not). */
export const waitingOn = (issue: Issue, blockers: Issue[]): string[] =>
  issue.status.canonical === "blocked" ? openBlockerKeys(blockers) : [];

/**
 * Links each blocker as blocking the new ticket. The ticket exists already, so a link the tracker refuses is reported
 * rather than failing the call. Returns the lines that say what was linked.
 */
export async function linkBlockers(
  tracker: Tracker,
  issue: Issue,
  blockers: Issue[],
): Promise<string[]> {
  const linked: string[] = [];
  const failed: string[] = [];
  for (const b of blockers) {
    try {
      await tracker.link(b.key, issue.key, "blocks");
      linked.push(b.key);
    } catch (error) {
      if (!(error instanceof PortError)) {
        throw error;
      }

      failed.push(`${b.key} (${error.message})`);
    }
  }

  const starts =
    issue.status.canonical === "blocked"
      ? " It starts blocked and moves to ready when its last blocker closes."
      : "";

  return [
    ...(linked.length ? [`Blocked by ${linked.join(", ")}.${starts}`] : []),
    ...(failed.length
      ? [
          `Could not link ${failed.join(", ")} as blocking ${issue.key}: link it with ost ticket link ${issue.key} --blocked-by <key>.`,
        ]
      : []),
  ];
}
