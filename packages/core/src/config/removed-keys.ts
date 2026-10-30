import type { RemovedKeys } from "./types.js";

/** The message for a key the event pipeline replaced (decision 0018). */
const pipeline = (key: string, instead: string) =>
  `${key} was removed: the event pipeline is the only way the office decides (decision 0018). ${instead}`;

const policy = (key: string, ids: string) =>
  pipeline(key, `To turn the behaviour off, set pipeline.policies.<id>.enabled: false for ${ids}.`);

const MODEL_INSTEAD = "Set the model of each person with people[].model in team.yaml.";

/** Removed from team.yaml, including the options of the adapters it names. */
export const REMOVED_TEAM_KEYS: RemovedKeys = {
  "network.adb":
    "network.adb was removed. Let the agent reach the device through the deployment's network policy (for example a Kubernetes NetworkPolicy) and declare adb under tools, with deny rules for the commands it must not run.",
  "runtime.model": `The runtime's model option was removed: there is no default model. ${MODEL_INSTEAD}`,
  "office.pipeline": pipeline(
    "office.pipeline",
    "It always runs; remove the key. Change its policies under pipeline.policies.",
  ),
  "workflow.preset": pipeline(
    "workflow.preset",
    "The presets are gone; the default policies apply. Change them under pipeline.policies.",
  ),
  "workflow.rules": pipeline(
    "workflow.rules",
    "Turn a default policy off, narrow it (when) or change its instruction under pipeline.policies.<id>.",
  ),
  "workflow.templates": pipeline(
    "workflow.templates",
    "The office posts no comment templates; change what a woken agent is told with pipeline.policies.<id>.instruction.",
  ),
  "feedback.merged_prs": policy("policies.feedback.merged_prs", "merged_feedback_to_author"),
  "feedback.doc_comments": policy("policies.feedback.doc_comments", "doc_comment_to_agent"),
  "feedback.ticket_comments": policy(
    "policies.feedback.ticket_comments",
    "ticket_comment_to_agent and ticket_comment_to_last_worker",
  ),
  "feedback.mentions": pipeline(
    "policies.feedback.mentions",
    "A comment that mentions an agent wakes that agent (ticket_comment_to_agent, doc_comment_to_agent); the agent takes the ticket itself if the comment asks it to.",
  ),
  "hand_back.reassign": policy(
    "policies.hand_back.reassign",
    "hand_back_done and hand_back_blocked, which move the ticket and give it to the requester",
  ),
  "policies.conflicts": policy("policies.conflicts", "rebase_to_author"),
  "retry.on_signal": pipeline(
    "policies.retry.on_signal",
    "A human's comment, review or assignment wakes the agent with a new round through the pipeline's policies; remove the key.",
  ),
  "tickets.start_moves_active": pipeline(
    "policies.tickets.start_moves_active",
    "The agent moves its ticket to active when it starts the work; remove the key.",
  ),
};

/** Removed from a catalog role's role.yaml. */
export const REMOVED_ROLE_KEYS: RemovedKeys = {
  default_model: `default_model was removed: there is no default model. ${MODEL_INSTEAD}`,
};

/** What to do instead of the removed key at `path`, or undefined when it is merely unknown. */
export function removedKey(
  path: readonly (string | number)[],
  removed: RemovedKeys,
): string | undefined {
  return removed[path.slice(-2).join(".")];
}
