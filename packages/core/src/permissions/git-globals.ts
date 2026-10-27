import { deny } from "./decision.js";
import { resolvePath } from "./paths.js";
import type { Decision, GitGlobals, Policy } from "./types.js";

const SAFE_GLOBAL = new Set(["--no-pager", "-P", "--no-optional-locks", "--paginate", "-p"]);

/** Global options that take their value as the next word. */
const VALUED_GLOBAL = new Set(["--git-dir", "--work-tree", "--namespace", "--super-prefix"]);

/**
 * Config keys that can change where or how a push goes, or skip the hooks that guard it: remotes and URL rewrites,
 * aliases, credential helpers, hooks, the transport and includes of other config files.
 */
export const PUSH_KEYS =
  /^(remote\.|url\.|alias\.|credential|core\.(hookspath|sshcommand|gitproxy|askpass|fsmonitor)|push\.|branch\.[^.]+\.(remote|pushremote|merge)$|include|http\.|protocol\.)/i;

/** Reads the options before the subcommand (`args` are the words after `git`); a decision when one is denied. */
export function readGlobals(policy: Policy, args: string[], cwd: string): GitGlobals | Decision {
  const globals: GitGlobals = { cwd, redirected: false, next: 0 };
  for (; args[globals.next]?.startsWith("-"); globals.next++) {
    const denied = readGlobal(policy, args, globals);
    if (denied) {
      return denied;
    }
  }

  return globals;
}

function readGlobal(policy: Policy, args: string[], globals: GitGlobals): Decision | undefined {
  const a = args[globals.next]!;
  if (a === "-C") {
    return changeDirectory(policy, args, globals);
  }

  if (a === "-c" || a.startsWith("--config-env")) {
    return configOverride(args, globals);
  }

  if (!SAFE_GLOBAL.has(a)) {
    // --git-dir, --work-tree and the like make the repository something other than the directory.
    globals.redirected = true;
    globals.next += VALUED_GLOBAL.has(a) ? 1 : 0;
  }
}

function changeDirectory(
  policy: Policy,
  args: string[],
  globals: GitGlobals,
): Decision | undefined {
  const dir = args[++globals.next];
  if (dir === undefined) {
    return deny("git -C needs a directory.", "git.syntax");
  }

  globals.cwd = resolvePath(dir, globals.cwd, policy.home);
}

/** `-c key=value` or `--config-env=key=ENV`: denied when the key could redirect a push or skip its hooks. */
function configOverride(args: string[], globals: GitGlobals): Decision | undefined {
  const a = args[globals.next]!;
  const value = a === "-c" ? (args[++globals.next] ?? "") : a.slice(a.indexOf("=") + 1);
  if (PUSH_KEYS.test(value)) {
    return deny(
      `git ${a.split("=")[0]} ${value.split("=")[0]} could redirect a push or skip its hooks.`,
      "git.config-override",
    );
  }
}
