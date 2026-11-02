import { maskSecrets } from "@outstaff/core";
import type { ContextFailedCheck } from "@outstaff/protocol";
import type { WorkItem } from "#/store/types.js";
import type { MergeCheck, PrRecord } from "#/workstate/index.js";
import type { ContextReaders } from "./types.js";

/** The kind of item a failed check on a merge commit wakes. */
export const MERGE_CHECKS_FAILED_KIND = "merge_checks_failed";

/** The bounds of what a wake carries of a log: the checks, the lines of each failed step, the characters of a line. */
const CHECKS = 3;
const LINES = 60;
const LINE_CHARS = 400;

const cutLine = (line: string) =>
  line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)} ... (cut)` : line;

type Logs = Pick<NonNullable<ContextReaders["vcs"]>, "checkLog">;

/** The failed steps of one check, or a note saying why there are none. */
async function stepsOf(
  vcs: Logs | undefined,
  rec: PrRecord,
  check: MergeCheck,
  timedOut: boolean,
): Promise<Pick<ContextFailedCheck, "steps" | "note">> {
  if (timedOut) {
    return { steps: [], note: "It was still running when the office stopped waiting for it." };
  }

  if (!check.logId || !vcs?.checkLog) {
    return { steps: [], note: "No step log is available for this check; see its link." };
  }

  try {
    const log = await vcs.checkLog(rec.ref.repo, check.logId, { tail: LINES });
    const steps = log.failedSteps.map((s) => ({
      name: s.name,
      lines: s.lines.map((l) => cutLine(maskSecrets(l))),
      omitted: s.omitted,
    }));

    return steps.length
      ? { steps }
      : { steps, note: "The log shows no failed step; see the link." };
  } catch (error) {
    return { steps: [], note: `The office could not read the log: ${(error as Error).message}` };
  }
}

const prOf = (item: WorkItem) =>
  item.kind === MERGE_CHECKS_FAILED_KIND && item.subject?.type === "pr"
    ? item.subject.ref
    : undefined;

/** The merged pull request an item is about, when it was woken by checks that failed on its merge commit. */
async function failedMerge(r: ContextReaders, item: WorkItem) {
  const key = prOf(item);
  if (!key) {
    return undefined;
  }

  const rec = (await r.store.getSubject("pr", key))?.data as PrRecord | undefined;
  const merge = rec?.mergeChecks;
  return rec && merge?.state === "failed" ? { key, rec, merge } : undefined;
}

/** One failing check of the merge, with what of its log could be read. */
async function entryOf(
  r: ContextReaders,
  found: NonNullable<Awaited<ReturnType<typeof failedMerge>>>,
  check: MergeCheck,
): Promise<ContextFailedCheck> {
  const { key, rec, merge } = found;
  return {
    pr: key,
    ...(merge.sha ? { sha: merge.sha } : {}),
    name: check.name,
    ...(check.url ? { url: check.url } : {}),
    ...(merge.timedOut ? { timedOut: true } : {}),
    ...(await stepsOf(r.vcs, rec, check, merge.timedOut === true)),
  };
}

/**
 * For an item woken by a failed check on a merge commit: each failing check, with the end of its failed step's log,
 * read now with the office's credentials, bounded and with secrets masked. Undefined for any other item.
 */
export async function failedChecksOf(
  r: ContextReaders,
  item: WorkItem,
): Promise<ContextFailedCheck[] | undefined> {
  const found = await failedMerge(r, item);
  if (!found) {
    return undefined;
  }

  const out: ContextFailedCheck[] = [];
  for (const check of (found.merge.failing ?? []).slice(0, CHECKS)) {
    out.push(await entryOf(r, found, check));
  }

  return out;
}
