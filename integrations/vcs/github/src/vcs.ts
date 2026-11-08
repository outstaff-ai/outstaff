import type { AdapterContext, Vcs } from "@outstaff/core";
import type { GithubDeps, GithubOptions } from "./types.js";
import { autoMergeOperations } from "./vcs/auto-merge.js";
import { checkLinkOperations } from "./vcs/check-link.js";
import { checkOperations } from "./vcs/checks.js";
import { githubHostCli } from "./host-cli.js";
import { createGithubContext } from "./vcs/context.js";
import { conversationOperations } from "./vcs/conversation.js";
import { eventOperations } from "./vcs/events.js";
import { historyOperations } from "./vcs/history.js";
import { identityOperations } from "./vcs/identity.js";
import { imageOperations } from "./vcs/images.js";
import { pullOperations } from "./vcs/pulls.js";
import { requirementOperations } from "./vcs/requirements.js";
import { reviewOperations } from "./vcs/reviews.js";

export function createGithubVcs(ctx: AdapterContext<GithubOptions>, deps: GithubDeps = {}): Vcs {
  const c = createGithubContext(ctx, deps);
  return {
    links: c.links,
    hostCli: githubHostCli(ctx.options),
    ...identityOperations(c),
    ...pullOperations(c),
    ...requirementOperations(c),
    ...autoMergeOperations(c),
    ...checkOperations(c),
    ...historyOperations(c),
    ...checkLinkOperations(c),
    ...reviewOperations(c),
    ...conversationOperations(c),
    ...eventOperations(c),
    ...imageOperations(c),
  };
}
