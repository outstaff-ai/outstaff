import type { Capability } from "../types.js";
import type { Condition, Rule } from "../workflow/types.js";

/** A switch holds `true`/`false`, or one of a few named choices; `none` always means off. */
export type PolicyValue = boolean | string;

export interface PolicySwitch {
  /** Dotted path under `policies` in team.yaml. */
  path: string;

  /** Value when team.yaml says nothing. Everything that happens today is on by default. */
  default: PolicyValue;

  /** The value that turns the behaviour off (or, for a limit, lifts it). */
  off: false | "none" | "many" | "agent";

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
            { ticket_status: ["backlog", "ready", "active", "review", "blocked"] },
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
    path: "design.canvas",
    default: true,
    off: false,
    kind: "agent",
    behaviour:
      "Let a role that declares the design.canvas capability (the stock designer) use Claude's Artifact tools to work on a private Design canvas, with a persistent artifacts folder in its home. Roles without the capability never get them. Needs the claude-agent-sdk runtime signed in with a Claude account; `ost doctor` checks it.",
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
    path: "feedback.doc_comments",
    default: true,
    off: false,
    kind: "rule",
    rules: ["doc-feedback-to-author"],
    behaviour:
      "Schedule the agent who wrote a knowledge document to answer a trusted person's comment or reply on it: it reads the open comments, updates the document, replies to each and resolves a thread only when the last word is its own. The office polls the comments of documents agents wrote for open work.",
    needs: "knowledge.docs",
  },
  {
    path: "feedback.ticket_comments",
    default: true,
    off: false,
    kind: "rule",
    rules: ["ticket-comment-to-assignee", "ticket-comment-reactivates-ticket"],
    behaviour:
      "Start a round for the assigned agent when a trusted person comments on its ticket. On a ticket the agent handed back (assigned to a person, in review or blocked) the comment counts as feedback: the ticket goes back to the agent who last worked on it and moves to active. Comments by agents and by the office never start anything.",
  },
  {
    path: "feedback.mentions",
    default: true,
    off: false,
    kind: "rule",
    rules: ["mention-assigns-agent", "doc-mention-feedback", "doc-mention-assigns-ticket"],
    behaviour:
      "A trusted person who mentions a team agent (`@username`) in a ticket comment hands that agent the ticket: it is assigned to the agent, moved to active when it is in backlog, ready, review or blocked, and the agent gets a round with the comment. When several agents are mentioned, the first takes the ticket and the others get a round to answer on it. A mention in a document comment gives the agent a round on the document, and its ticket goes to the agent when nobody or only a person has it. Comments by agents and by the office never mention anyone, and a done or canceled ticket is left alone. A mention goes to the agent mentioned, not to the assignee or the agent who last worked on the ticket.",
  },
  {
    path: "hand_back.reassign",
    default: "requester",
    off: "none",
    kind: "rule",
    rules: ["hand-back-to-requester", "hand-back-blocked-to-requester"],
    behaviour:
      "When an agent hands work back, move the ticket to review (done), or to blocked (blocked), and assign it to the person who asked for it. A waiting hand-back changes nothing. With none the ticket still moves but keeps its assignee.",
    rewrite: (rule, value) =>
      value === "none" ? { ...rule, do: rule.do.filter((a) => !("assign" in a)) } : rule,
  },
  {
    path: "hand_back.blocked_notify",
    default: "pm",
    off: "agent",
    kind: "rule",
    rules: ["hand-back-blocked-to-requester"],
    behaviour:
      "Who deals with a blocked hand-back before a human is pulled in. With pm (the default when the team has a PM role) the office schedules an unblock round for the PM, who tries to unblock it and messages the requester only if a human is needed. With agent, or when the team has no PM, the blocked agent tells the requester itself, in its own direct message with the ticket linked. The thread of a chat item always gets its agent's reply. Items the scheduler blocks are routed the same way. The office never posts to people.",
    rewrite: (rule, value) =>
      value === "agent" ? { ...rule, do: rule.do.filter((a) => !("schedule" in a)) } : rule,
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
      "One pull request per ticket, because the ticket moves to done when its last open pull request merges into the default branch (a merge into another pull request's branch, or while another pull request of the ticket is open, leaves it where it is): `ost pr open` refuses a second pull request for a ticket (open or merged) and points to `ost ticket create --parent`, and a second pull request a person opens gets a comment on the ticket that says which merge closes it. With many, several pull requests are allowed and the ticket moves to done only when the agent hands its work back as done and every pull request linked to it is closed with at least one merged; a merge alone does not close it.",
    rewrite: manyPrs,
  },
  {
    path: "tickets.start_moves_active",
    default: true,
    off: false,
    kind: "office",
    behaviour:
      "When a work item about a ticket starts, the office moves the ticket to active if it is in backlog, ready or review, so the board shows the work without the agent having to say so. Rounds that only answer something (asked, document feedback) and chat sessions never move it, and neither does the minimal preset, which never moves tickets. A blocked ticket stays blocked until the agent moves it: a retry that is still blocked leaves it blocked. Work that starts on an open pull request moves a ticket closed early (done) back to active. The agent still keeps the ticket accurate as it goes.",
  },
  {
    path: "pull_ready",
    default: true,
    off: false,
    kind: "office",
    behaviour:
      "When an agent has nothing queued or running (when a ticket is created or assigned to it or moves into ready, after a hand-back, on the scheduler's tick, when it connects), the office starts its next ready ticket: one assigned to it, in the ready status, the highest tracker priority first, then the one that entered ready the longest ago. A ticket in backlog, one assigned to someone else, and one the agent already worked on since it entered ready are never pulled. It counts as automatic work: usage above `usage.pause_automatic_at` stops it, and the loop guard covers each item.",
  },
  {
    path: "merge.on_approval",
    default: false,
    off: false,
    kind: "agent",

    // The verb enforces it whatever the preset; the rule only schedules the merge, and exists only while the switch is on.
    rules: ["approved-merge", "approved-merge-after-feedback"],
    needs: "vcs.merge",
    behaviour:
      "Let an agent merge its own pull request when an allowed approver (policies.merge.approvers) approves it. A bare approval schedules a merge item for the author at once; an approval with comments schedules the review round first, and the merge follows its done hand-back. The author runs `ost pr merge`: it checks the approvals, the required checks, mergeability and the draft state, then queues the pull request in the host's merge queue or merges it with the configured method. It never bypasses branch protection or rulesets. Off: the verb refuses and no merge is scheduled.",
  },
  {
    path: "conflicts.follow_up",
    default: true,
    off: false,
    kind: "rule",
    rules: ["conflict-back-to-author"],
    behaviour:
      "When an open pull request starts to conflict with its base, for example after another one merged, send it back to its agent author to rebase, whatever the status of its ticket (a done ticket goes back to active; a canceled one is left alone).",
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

/**
 * Who deals with a blocked hand-back: the PM when the team has one and the switch says so, else the blocked agent
 * itself. A team without a PM role cannot route to one, whatever the switch says.
 */
export function blockedNotify(team: {
  people: readonly { role: string }[];
  policies?: PolicyConfig;
}): "pm" | "agent" {
  const hasPm = team.people.some((p) => p.role === "pm");
  return hasPm && policyValue(team.policies, "hand_back.blocked_notify") === "pm" ? "pm" : "agent";
}
