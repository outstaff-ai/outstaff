import type { RemovedKeys } from "./types.js";

const MODEL_INSTEAD = "Set the model of each person with people[].model in team.yaml.";

/** Removed from team.yaml, including the options of the adapters it names. */
export const REMOVED_TEAM_KEYS: RemovedKeys = {
  "network.adb":
    "network.adb was removed. Let the agent reach the device through the deployment's network policy (for example a Kubernetes NetworkPolicy) and declare adb under tools, with deny rules for the commands it must not run.",
  "runtime.model": `The runtime's model option was removed: there is no default model. ${MODEL_INSTEAD}`,
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
