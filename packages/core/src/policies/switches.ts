import type { Capability } from "../capabilities.js";
import type { Condition, Rule } from "../workflow/rules.js";

/** A switch holds `true`/`false`, or one of a few named choices; `none` always means off. */
export type PolicyValue = boolean | string;

export interface PolicySwitch {
  /** Dotted path under `policies` in team.yaml. */
  path: string;

  /** Value when team.yaml says nothing. Everything that happens today is on by default. */
  default: PolicyValue;

  /** The value that turns the behaviour off (or, for a limit, lifts it). */
  off: false | "none" | "many";

  /** What outstaff does while the switch is on, for `ost policies` and the docs. */
  behaviour: string;

  /** Who carries the behaviour out: a preset workflow rule, or code in the agent or the office. */
  kind: "rule" | "agent" | "office" | "option";

  /** The preset workflow rules the switch governs, by id. */
  rules?: readonly string[];

  /**
   * How a governed rule changes when the switch is not at its default. Return `undefined` to remove the rule.
   * Without it, a switch that is off removes its rules.
   */
  rewrite?: (rule: Rule, value: PolicyValue) => Rule | undefined;

  /** The capability the configured adapter needs for the switch to do anything; `validate` warns when it lacks it. */
  needs?: Capability;
}

/** `tickets.prs_per_ticket: many`: the ticket is done when the agent says so and every pull request is settled. */
function manyPrs(rule: Rule): Rule {
  const settled: Condition = { ticket_prs_all_closed: true };
  switch (rule.id) {
    case "pr-merged-done":
      // Whichever of the three happens last closes the ticket: the last merge or close, or the hand-back.
      return {
        ...rule,
        on: ["pr.merged", "pr.closed", "agent.handed_back"],
        if: {
          all: [
            ...(rule.if ? [rule.if] : []),
            settled,
            { any: [{ hand_back_status: ["done"] }, { ticket_handed_back: true }] },
          ],
        },
      };
    case "pr-closed-ready":
      // Only the last pull request closed unmerged sends the ticket back: none other open, none merged.
      return {
        ...rule,
        if: {
          all: [
            ...(rule.if ? [rule.if] : []),
            { not: { ticket_prs_open: true } },
            { not: settled },
          ],
        },
      };
    case "hand-back-to-requester":
      // The hand-back that settles the ticket closes it instead of asking the requester to review.
      return { ...rule, if: { all: [...(rule.if ? [rule.if] : []), { not: settled }] } };
    case "second-pr-comment":
      return { ...rule, do: [{ comment: "second_pr_many" }] };
    default:
      return rule;
  }
}

/**
 * Every automated behaviour a team can switch, in the order `ost policies` and the docs list them. Adding a
 * switch (merge on approval, reviewer agents) is one entry here plus the schema key; the CLI, the docs page,
 * `ost workflow explain` and validation read this table.
 */
export const POLICY_SWITCHES: readonly PolicySwitch[] = [
  {
    path: "acknowledge.chat",
    default: true,
    off: false,
    kind: "agent",
    behaviour:
      "React with eyes to a chat message from a trusted person as soon as the agent has seen it.",
  },
  {
    path: "acknowledge.vcs",
    default: true,
    off: false,
    kind: "agent",
    behaviour:
      "React with eyes to each pull request comment the agent is about to answer, when its round starts.",
    needs: "vcs.reactions",
  },
  {
    path: "chat.profile",
    default: true,
    off: false,
    kind: "agent",
    behaviour:
      "Publish the agent's profile in chat (for Slack, the Home tab): its role, whether it is working or idle, and its current work grouped by ticket or pull request. It updates when the work changes and at least every 5 minutes while working.",
    needs: "chat.agentProfile",
  },
  {
    path: "feedback.follow_up_round",
    default: true,
    off: false,
    kind: "office",
    behaviour:
      "Start another round when feedback arrived after the agent was offered its work, so nothing written during a round is lost.",
  },
  {
    path: "feedback.merged_prs",
    default: true,
    off: false,
    kind: "rule",
    rules: ["merged-feedback-follow-up"],
    behaviour:
      "Schedule the author to answer a trusted person's review or comment on an already merged pull request, and to open a follow-up pull request if a change is asked for.",
  },
  {
    path: "hand_back.reassign",
    default: "requester",
    off: "none",
    kind: "rule",
    rules: ["hand-back-to-requester", "hand-back-blocked-to-requester"],
    behaviour:
      "When an agent hands work back, move the ticket to review (done), or to blocked and tell the requester (blocked), and assign it to the person who asked for it. A waiting hand-back changes nothing. With none the ticket still moves but keeps its assignee.",
    rewrite: (rule, value) =>
      value === "none" ? { ...rule, do: rule.do.filter((a) => !("assign" in a)) } : rule,
  },
  {
    path: "hand_back.fallback",
    default: "first_human",
    off: "none",
    kind: "option",
    behaviour:
      "When a ticket has no known requester, hand it back to the first human in `humans`. With none, a rule that needs a requester is skipped when the ticket has none.",
  },
  {
    path: "tickets.prs_per_ticket",
    default: "one",
    off: "many",

    // The verb enforces it whatever the preset; the rules only follow it, so a preset without them is no reason to call it off.
    kind: "agent",
    rules: ["pr-merged-done", "pr-closed-ready", "hand-back-to-requester", "second-pr-comment"],
    behaviour:
      "One pull request per ticket, because the ticket moves to done when its pull request merges: `ost pr open` refuses a second pull request for a ticket (open or merged) and points to `ost ticket create --parent`, and a second pull request a person opens gets a comment on the ticket that says which merge closes it. With many, several pull requests are allowed and the ticket moves to done only when the agent hands its work back as done and every pull request linked to it is closed with at least one merged; a merge alone does not close it.",
    rewrite: manyPrs,
  },
  {
    path: "conflicts.follow_up",
    default: true,
    off: false,
    kind: "rule",
    rules: ["conflict-back-to-author"],
    behaviour:
      "When a pull request starts to conflict with its base, for example after another one merged, send it back to its agent author to rebase.",
  },
  {
    path: "retry.on_signal",
    default: true,
    off: false,
    kind: "office",
    behaviour:
      "Retry a blocked work item when a trusted human moves its ticket, assigns it, reviews or comments on its pull request, or replies in its chat thread.",
  },
];

export const POLICY_SWITCH_PATHS = POLICY_SWITCHES.map((s) => s.path);

/** The shape of `policies` the switches read; a parsed team config satisfies it. */
export type PolicyConfig = { [group: string]: unknown } | undefined;

export function policySwitch(path: string): PolicySwitch {
  const found = POLICY_SWITCHES.find((s) => s.path === path);
  if (!found) {
    throw new Error(`Unknown policy switch ${path}.`);
  }

  return found;
}

/** The value of one switch: what team.yaml says, else the default. */
export function policyValue(policies: PolicyConfig, path: string): PolicyValue {
  let node: unknown = policies;
  for (const key of path.split(".")) {
    node =
      typeof node === "object" && node !== null
        ? (node as Record<string, unknown>)[key]
        : undefined;
  }

  return typeof node === "boolean" || typeof node === "string" ? node : policySwitch(path).default;
}

/** True unless the switch is at its off value. */
export const policyOn = (policies: PolicyConfig, path: string): boolean =>
  policyValue(policies, path) !== policySwitch(path).off;

/** The switch that governs a preset rule, if any. */
export function switchOfRule(ruleId: string): PolicySwitch | undefined {
  return POLICY_SWITCHES.find((s) => s.rules?.includes(ruleId));
}
