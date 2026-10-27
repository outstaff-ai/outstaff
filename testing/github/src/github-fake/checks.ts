import type { VcsSeed } from "@outstaff/core/contracts";
import type { GithubStore, StoredCheckRun } from "../stand-in/types.js";

type SeedCheck = Parameters<VcsSeed["check"]>[2];

const CONCLUSION: Record<string, string> = {
  success: "success",
  failure: "failure",
  neutral: "neutral",
};

/** The raw text of an Actions log: each step a group, its lines, and the error that failed it. */
const logText = (steps: NonNullable<SeedCheck["log"]>["steps"]) =>
  steps
    .flatMap((st, i) => [
      `2026-01-01T00:00:0${i}.0000000Z ##[group]${st.name}`,
      `2026-01-01T00:00:0${i}.0000000Z ##[endgroup]`,
      ...st.lines.map((l) => `2026-01-01T00:00:0${i}.1000000Z ${l}`),
      ...(st.failed
        ? [`2026-01-01T00:00:0${i}.2000000Z ##[error]Process completed with exit code 1.`]
        : []),
    ])
    .join("\n");

/** Adds a check run on a commit; one with a log is an Actions job whose log can be read. */
export function seedCheck(s: GithubStore, sha: string, c: SeedCheck) {
  const id = ++s.counters.checkId;
  const run: StoredCheckRun = {
    id,
    name: c.name,
    status: c.status === "pending" ? "in_progress" : "completed",
    conclusion: CONCLUSION[c.status] ?? null,
    ...(c.log ? { job: true } : {}),
  };

  if (c.log) {
    s.jobs.set(id, {
      steps: c.log.steps.map((st) => ({
        name: st.name,
        conclusion: st.failed ? "failure" : "success",
      })),
      log: logText(c.log.steps),
    });
  }

  s.checks.set(sha, [...(s.checks.get(sha) ?? []), run]);
}
