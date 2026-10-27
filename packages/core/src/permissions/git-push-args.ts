import { deny } from "./decision.js";
import type { Decision, PushArgs } from "./types.js";

/** What reading one push option says: denied, a value follows ("value"), or nothing to judge. */
type FlagResult = Decision | "value" | undefined;

const forceDenied = (): Decision =>
  deny("Bare force-push is denied; use --force-with-lease on your own branch.", "git.push.force");

const unknownFlag = (a: string): Decision =>
  deny(`Unknown push flag ${a}; the push rules cannot judge it.`, "git.push.unknown-flag");

const mirror = (a: string): Decision =>
  deny(`${a} could overwrite the default branch.`, "git.push.mirror");

/** Options that change nothing the push rules judge. */
const HARMLESS = [
  "--set-upstream",
  "--dry-run",
  "--verbose",
  "--quiet",
  "--tags",
  "--follow-tags",
  "--atomic",
  "--progress",
  "--no-progress",
  "--thin",
  "--no-thin",
  "--porcelain",
];

/** Long options matched exactly. */
const LONG_FLAGS = new Map<string, (a: string, args: PushArgs) => FlagResult>([
  ["--force", forceDenied],
  ["--mirror", mirror],
  ["--all", mirror],
  ["--prune", mirror],
  ["--no-verify", () => deny("Skipping hooks is denied.", "git.push.no-verify")],
  [
    "--delete",
    (_a, args) => {
      args.del = true;
    },
  ],
  [
    "--force-if-includes",
    (_a, args) => {
      args.forceLease = true;
    },
  ],
  ["--push-option", () => "value"],
  ...HARMLESS.map((flag): [string, () => FlagResult] => [flag, () => undefined]),
]);

/** Options that choose the program run on the remote, or the remote itself. */
const TRANSPORT = /^--(receive-pack|exec|repo)(=|$)/;

/** Reads the options of a `git push` (the words after `push`); a decision when one of them is denied. */
export function readPushArgs(rest: string[]): PushArgs | Decision {
  const args: PushArgs = { del: false, forceLease: false, positionals: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--") {
      args.positionals.push(...rest.slice(i + 1));
      break;
    }

    const result = readPushArg(a, args);
    if (result === "value") {
      i++;
    } else if (result) {
      return result;
    }
  }

  return args;
}

function readPushArg(a: string, args: PushArgs): FlagResult {
  if (a.startsWith("--")) {
    return readLongFlag(a, args);
  }

  if (a.startsWith("-") && a.length > 1) {
    return readShortFlags(a, args);
  }

  args.positionals.push(a);
}

function readLongFlag(a: string, args: PushArgs): FlagResult {
  const exact = LONG_FLAGS.get(a);
  if (exact) {
    return exact(a, args);
  }

  if (a.startsWith("--force-with-lease")) {
    args.forceLease = true;

    return undefined;
  }

  if (TRANSPORT.test(a)) {
    return deny(`${a.split("=")[0]} is denied.`, "git.push.transport");
  }

  return a.startsWith("--push-option=") ? undefined : unknownFlag(a);
}

/** A cluster of short options such as `-uv`. */
function readShortFlags(a: string, args: PushArgs): FlagResult {
  if (a === "-o") {
    return "value";
  }

  for (const ch of a.slice(1)) {
    const denied = readShortFlag(ch, a, args);
    if (denied) {
      return denied;
    }
  }
}

function readShortFlag(ch: string, a: string, args: PushArgs): Decision | undefined {
  if (ch === "f") {
    return forceDenied();
  }

  if (ch === "d") {
    args.del = true;
  } else if (!"unvq".includes(ch)) {
    return unknownFlag(a);
  }
}
