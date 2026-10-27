import { CONFIG_CODES } from "./codes.js";
import { customIssue } from "./issues.js";
import { runtimeOf } from "./runtime-of.js";
import type { TeamConfig } from "./types.js";

type Config = Pick<TeamConfig, "people" | "integrations"> & {
  policies?: { usage?: { shared?: string[][] | undefined } } | undefined;
};

type Issue = ReturnType<typeof customIssue>;

/** The one problem of a group member, if any: unknown, in another group already, or on another runtime. */
function memberIssue(
  runtimes: Map<string, string>,
  first: string | undefined,
  handle: string,
  path: (string | number)[],
  grouped: Set<string>,
): Issue | undefined {
  const runtime = runtimes.get(handle);
  if (runtime === undefined) {
    return customIssue(
      CONFIG_CODES.usageSharedUnknownPerson,
      `Usage group refers to unknown person "${handle}".`,
      path,
    );
  }

  if (grouped.has(handle)) {
    return customIssue(
      CONFIG_CODES.usageSharedOverlap,
      `"${handle}" is in more than one usage group (or twice in one); a person has one subscription.`,
      path,
    );
  }

  const theirs = first === undefined ? undefined : runtimes.get(first);
  if (theirs !== undefined && runtime !== theirs) {
    return customIssue(
      CONFIG_CODES.usageSharedMixedRuntime,
      `"${handle}" runs on runtime "${runtime}" but "${first}" in the same usage group runs on "${theirs}"; a group shares one credential, so one runtime.`,
      path,
    );
  }

  return undefined;
}

/** One group's members: known, in no other group, and all on one runtime, since the group shares one credential. */
function groupIssues(cfg: Config, group: string[], g: number, grouped: Set<string>): Issue[] {
  const runtimes = new Map(cfg.people.map((p) => [p.handle, runtimeOf(cfg, p).adapter]));
  const first = group.find((h) => runtimes.has(h));
  const issues: Issue[] = [];
  group.forEach((handle, n) => {
    const issue = memberIssue(
      runtimes,
      first,
      handle,
      ["policies", "usage", "shared", g, n],
      grouped,
    );

    if (issue) {
      issues.push(issue);
    }

    grouped.add(handle);
  });

  return issues;
}

/** The problems of `policies.usage.shared`. */
export function usageSharedIssues(cfg: Config): Issue[] {
  const grouped = new Set<string>();
  return (cfg.policies?.usage?.shared ?? []).flatMap((group, g) =>
    groupIssues(cfg, group, g, grouped),
  );
}
