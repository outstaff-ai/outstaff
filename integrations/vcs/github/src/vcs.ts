import type { AdapterContext, Vcs } from "@outstaff/core";
import type { GithubDeps, GithubOptions } from "./types.js";
import { checkOperations } from "./vcs/checks.js";
import { createGithubContext } from "./vcs/context.js";
import { conversationOperations } from "./vcs/conversation.js";
import { eventOperations } from "./vcs/events.js";
import { identityOperations } from "./vcs/identity.js";
import { pullOperations } from "./vcs/pulls.js";
import { requirementOperations } from "./vcs/requirements.js";
import { reviewOperations } from "./vcs/reviews.js";

export function createGithubVcs(ctx: AdapterContext<GithubOptions>, deps: GithubDeps = {}): Vcs {
  const c = createGithubContext(ctx, deps);
  return {
    links: c.links,
    ...identityOperations(c),
    ...pullOperations(c),
    ...requirementOperations(c),
    ...checkOperations(c),
    ...reviewOperations(c),
    ...conversationOperations(c),
    ...eventOperations(c),
  };
}
