import type { CheckLogStep } from "@outstaff/core";

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/;
// oxlint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

interface Segment {
  title: string;
  lines: string[];
}

/** The steps of a failed job and which of them failed: from `GET /actions/jobs/{id}`. */
export function failedStepNames(steps: { name: string; conclusion: string | null }[]): string[] {
  return steps
    .filter((s) => s.conclusion === "failure" || s.conclusion === "timed_out")
    .map((s) => s.name);
}

/**
 * Cuts a job log into its failed steps and keeps the last `tail` lines of each. Lines carry an ISO timestamp, which is
 * removed. A step starts at a `##[group]` line and runs to the next one; GitHub puts a step's output, and its
 * `##[error]` line, after the group's `##[endgroup]`, so a step failed when its segment holds an `##[error]` line.
 * Without any, the segment titled like a failed step is taken, and failing that the tail of the whole log.
 */
export function failedSteps(text: string, failed: string[], tail: number): CheckLogStep[] {
  const segments: Segment[] = [{ title: "", lines: [] }];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(TIMESTAMP, "").replace(ANSI, "");
    if (line.startsWith("##[group]")) {
      segments.push({ title: line.slice("##[group]".length).trim(), lines: [] });
    } else if (!line.startsWith("##[endgroup]")) {
      segments.at(-1)!.lines.push(line);
    }
  }

  let picked = segments.filter((s) => s.lines.some((l) => l.startsWith("##[error]")));
  if (picked.length === 0) {
    picked = segments.filter((s) => s.title !== "" && failed.includes(s.title));
  }

  if (picked.length === 0) {
    if (failed.length === 0) {
      return [];
    }

    picked = [{ title: failed[0]!, lines: segments.flatMap((s) => s.lines) }];
  }

  return picked.map((s, i) => {
    const lines = [...s.lines];
    while (lines.length > 0 && lines.at(-1)!.trim() === "") {
      lines.pop();
    }

    const name = failed.includes(s.title)
      ? s.title
      : failed.length === picked.length
        ? failed[i]!
        : s.title || failed[0] || "log";

    const kept = lines.slice(Math.max(0, lines.length - tail));
    return { name, lines: kept, omitted: lines.length - kept.length };
  });
}

/** A PEM key and each line of its body: a log prints a key line by line, so each line is masked too. */
export function keyParts(pem: string): string[] {
  const body = pem.split(/\r?\n/).filter((l) => l.trim() !== "" && !l.startsWith("-----"));
  return [pem, ...body];
}
