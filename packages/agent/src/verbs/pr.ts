import { PortError } from "@outstaff/core";
import { z } from "zod";
import { repoLabel, requireVcs, resolveRepo } from "./support.js";
import { defineVerb, result } from "./types.js";

const repo = z
  .string()
  .min(1)
  .max(300)
  .describe("Repository: its name in team.yaml (for example shop) or host/owner/name.");

const number = z.number().int().min(1).describe("Pull request number.");

export const prStatus = defineVerb({
  name: "pr.status",
  summary: "Show a pull request's state, checks and open review threads.",
  description:
    "Shows a pull request: state, mergeability, checks and how many review threads are still open, with URLs.",
  input: z.strictObject({ repo, number }),
  args: ["repo", "number"],
  examples: ["ost pr status shop 42"],
  async run(env, input) {
    const vcs = requireVcs(env);
    const ref = resolveRepo(env, input.repo);
    const pr = await vcs.getPullRequest(ref, input.number, { waitForMergeable: true });
    const [checks, threads] = await Promise.all([
      vcs.checks(ref, pr.head.sha),
      vcs.reviewThreads(ref, input.number),
    ]);

    const url = vcs.links.pr(ref, pr.number);
    const open = threads.filter((t) => !t.resolved);
    const counts = (["success", "failure", "pending", "neutral"] as const)
      .map((s) => [s, checks.filter((c) => c.status === s).length] as const)
      .filter(([, n]) => n > 0)
      .map(([s, n]) => `${n} ${s}`);

    return result(
      [
        `${repoLabel(ref)}#${pr.number}: ${pr.title}`,
        `State: ${pr.state}${pr.draft ? " (draft)" : ""}; mergeable: ${pr.mergeable}`,
        url,
        `Checks: ${counts.length ? counts.join(", ") : "none"}`,
        ...checks.filter((c) => c.status === "failure").map((c) => `- failing: ${c.name} ${c.url}`),
        `Open review threads: ${open.length}`,
      ],
      { pr, checks, openThreads: open.length },
      [url, ...checks.filter((c) => c.status === "failure").map((c) => c.url)],
    );
  },
});

export const prThreads = defineVerb({
  name: "pr.threads",
  summary: "List the review threads of a pull request.",
  description:
    "Lists the review threads of a pull request with their ids, locations, comments and URLs. Open threads only unless all is set.",
  input: z.strictObject({
    repo,
    number,
    all: z.boolean().default(false).describe("Include resolved threads."),
  }),
  args: ["repo", "number"],
  examples: ["ost pr threads shop 42", "ost pr threads shop 42 --all"],
  async run(env, input) {
    const vcs = requireVcs(env);
    const ref = resolveRepo(env, input.repo);
    const threads = (await vcs.reviewThreads(ref, input.number)).filter(
      (t) => input.all || !t.resolved,
    );

    const urls = threads.map((t) => vcs.links.thread(ref, input.number, t.id));
    const pr = vcs.links.pr(ref, input.number);
    return result(
      threads.length
        ? threads.flatMap((t, i) => [
            `${t.id}${t.resolved ? " [resolved]" : ""}${t.path ? ` ${t.path}${t.line ? `:${t.line}` : ""}` : ""}`,
            urls[i]!,
            ...t.comments.map((c) => `  ${c.author}: ${c.body.trim()}`),
          ])
        : [
            `No ${input.all ? "" : "open "}review threads on ${repoLabel(ref)}#${input.number}.`,
            pr,
          ],
      { threads },
      [pr, ...urls],
    );
  },
});

export const prResolve = defineVerb({
  name: "pr.resolve",
  summary: "Resolve a review thread whose last comment is yours.",
  description:
    "Resolves a review thread after you have replied. It refuses when the last comment in the thread is not yours; the reviewer resolves those.",
  input: z.strictObject({
    repo,
    number,
    thread: z.string().min(1).max(200).describe("Thread id from pr threads."),
  }),
  args: ["repo", "number", "thread"],
  examples: ["ost pr resolve shop 42 PRT_abc123"],
  async run(env, input) {
    const vcs = requireVcs(env);
    const ref = resolveRepo(env, input.repo);
    const threads = await vcs.reviewThreads(ref, input.number);
    if (!threads.some((t) => t.id === input.thread)) {
      throw new PortError(
        "not_found",
        `No review thread ${input.thread} on ${repoLabel(ref)}#${input.number}.`,
      );
    }

    const url = vcs.links.thread(ref, input.number, input.thread);
    const outcome = await vcs.resolveThread(ref, input.thread);
    if (!outcome.resolved) {
      throw new PortError(
        "forbidden",
        `${outcome.reason ?? "The thread was not resolved."} ${url}`,
      );
    }

    return result(
      [`Resolved thread ${input.thread}.`, url],
      { thread: input.thread, resolved: true },
      [url],
    );
  },
});

export const prVerbs = [prStatus, prThreads, prResolve];
