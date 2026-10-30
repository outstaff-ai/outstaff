import { definePolicy } from "@outstaff/policy";
import { AGENT_PR_OPEN } from "./conditions.js";
import { wakes } from "./spec.js";

export const policy = definePolicy({
  id: "rebase_to_author",
  summary:
    "An agent's open pull request that conflicts, is behind its base, or whose base merged wakes its author, naming the merge that caused it.",
  on: ["pr.conflicted", "pr.behind_base", "pr.base_merged"],
  when: AGENT_PR_OPEN,
  instruction:
    "Your pull request #{{pr.number}} ({{pr.title}}) {{pr.problem}}{{cause}}. Bring it up to date with `{{pr.base}}` the way the repository asks, and push. Then keep the pull request description current; if the approach changed, comment with what changed and why.",
  ...wakes({ person: "author", kind: "rebase" }),
});
