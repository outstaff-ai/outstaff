/**
 * Keys that were part of team.yaml and are gone, by the parent key and the key, with what to do instead. They fail
 * validation like any unknown key, with this message.
 */
const REMOVED: Record<string, string> = {
  "network.adb":
    "network.adb was removed. Let the agent reach the device through the deployment's network policy (for example a Kubernetes NetworkPolicy) and declare adb under tools, with deny rules for the commands it must not run.",
};

/** What to do instead of the removed key at `path`, or undefined when it is merely unknown. */
export function removedKey(path: readonly (string | number)[]): string | undefined {
  return REMOVED[path.slice(-2).join(".")];
}
