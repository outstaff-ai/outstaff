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
      "Let a role that declares the design.canvas capability (the stock designer) use Claude's Artifact tools to work on a private Design canvas, with a persistent artifacts folder in its home, and a role that declares design.canvas.read (the stock developer, architect and PM) read those canvases and their comments, and nothing more. Roles with neither capability never get the tools. Needs the claude-agent-sdk runtime signed in with a Claude account, the one the canvases belong to; `ost doctor` checks it.",
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
      "One open pull request per ticket: `ost pr open` refuses a pull request for a ticket that has an open one, and points to `ost ticket create --parent`, or that is done or canceled; a merged one does not count while the ticket is open. With many, several pull requests are allowed. Either way the ticket moves to done when its last open pull request merges into the default branch and the checks on the merge commit pass (a merge into another pull request's branch, or while another pull request of the ticket is open, leaves it where it is).",
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
    path: "notify_handoff",
    default: true,
    off: false,
    kind: "agent",
    behaviour:
      "When work lands on a human, the agent tells them in a direct message from its own chat account: a ticket handed back to them for review, a blocked ticket given to them (by a PM that cannot unblock it, for example), or a pull request opened for their review, which is the requester of its ticket. The message links the ticket and the pull requests, and says in a line or two from the hand-back what is needed. One agent's messages to one human are batched: a message waits `pipeline.notify.debounce_seconds` (default 60, or longer than one poll of the office) for more, and while the agent's round on the ticket runs, so a pull request opened in a round goes with its hand-back. A ticket whose work is tied to a chat thread of the agent with the human (work filed or attached from chat, and its later rounds) is told as a reply in that thread instead of a direct message, nothing more when the round posts its own result there, and a round that puts nothing new in front of the human (a merge round on a merged pull request, a rebase that pushed nothing) tells them nothing. A human with no `identities.chat` is sent nothing, and the office logs it. A blocked hand-back on a team without a PM is told by the blocked agent itself (`hand_back.blocked_notify`).",
  },
  {
    path: "merge.on_approval",
    default: false,
    off: false,
    kind: "agent",
    needs: "vcs.merge",
    behaviour:
      "Let agents merge their own approved pull requests. When an agent's open, ready pull request may be ready to merge (an allowed approver approves it with its checks green, its checks turn green while it is approved, or the pull request it was stacked on merges), the office wakes its author with the merge context, and the agent decides: merge it with ost pr merge, wait, or coordinate first. One merge runs per repository at a time. Limited to policies.merge.repos when set. Off: no one is woken to merge and people merge.",
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
