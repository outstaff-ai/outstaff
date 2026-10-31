import type { PolicyConfig, PolicySwitch, PolicyValue } from "./types.js";

/**
 * Every automated behaviour a team can switch outside the event pipeline's policies, in the order `ost policies` and
 * the docs list them. Adding a switch is one entry here plus the schema key; the CLI, the docs page and validation
 * read this table.
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
    path: "hand_back.blocked_notify",
    default: "pm",
    off: "agent",
    kind: "agent",
    behaviour:
      "Who tells the requester about blocked work that did not come from chat. With agent, or when the team has no PM role, the blocked agent tells the requester itself, in its own direct message with the ticket linked. With pm the blocked agent sends nothing and leaves it to the PM, who gives the ticket to the requester, saying exactly what is needed, only when it cannot unblock it. Whichever the value, a blocked ticket goes to the team's PM to unblock when the team has one other than the blocked agent (the hand_back_blocked_to_pm policy); the switch only decides who sends the chat message. The thread of a chat item always gets its agent's reply. Items the scheduler blocks are handled the same way. The office never posts to people.",
  },
  {
    path: "hand_back.fallback",
    default: "first_human",
    off: "none",
    kind: "option",
    behaviour:
      "When a ticket has no known requester, hand it back to the first human in `humans` with a tracker identity. With none, an act that assigns the requester is dropped when the ticket has none.",
  },
  {
    path: "tickets.prs_per_ticket",
    default: "one",
    off: "many",
    kind: "agent",
    behaviour:
      "One pull request per ticket: `ost pr open` refuses a second pull request for a ticket (open or merged) and points to `ost ticket create --parent`. With many, several pull requests are allowed. Either way the ticket moves to done when its last open pull request merges into the default branch (a merge into another pull request's branch, or while another pull request of the ticket is open, leaves it where it is).",
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
    needs: "vcs.merge",
    behaviour:
      "Let agents turn on the code host's auto-merge on their pull requests: when an agent marks its pull request ready for review (or opens it ready), the same verb turns on auto-merge, or adds it to the merge queue where the repository has one. The repository's own rules (required approvals and checks) decide when it merges, with the repository's merge method; no agent runs for the merge, and the office only sees it merge. Limited to policies.merge.repos when set. Off: nothing is turned on and people merge.",
  },
];

export const POLICY_SWITCH_PATHS = POLICY_SWITCHES.map((s) => s.path);

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

/**
 * Who tells the requester about blocked work: the PM when the team has one and the switch says so, else the blocked
 * agent itself. A team without a PM role cannot leave it to one, whatever the switch says.
 */
export function blockedNotify(team: {
  people: readonly { role: string }[];
  policies?: PolicyConfig;
}): "pm" | "agent" {
  const hasPm = team.people.some((p) => p.role === "pm");
  return hasPm && policyValue(team.policies, "hand_back.blocked_notify") === "pm" ? "pm" : "agent";
}
