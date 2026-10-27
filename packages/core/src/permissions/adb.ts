/** adb options before the command that take a value. */
const VALUED = new Set(["-s", "-t", "-H", "-P", "-L"]);

/** Package names of the platform itself, whose removal or reset can break the device. */
const SYSTEM_PACKAGE = /^(android|com\.android\.|com\.google\.)/i;
const REBOOT_MODES = ["bootloader", "recovery", "sideload", "fastboot"];
const PM_REMOVALS = new Set(["uninstall", "disable", "disable-user", "hide", "suspend", "clear"]);

/** The device's data roots, and the roots of its system partitions. */
const DATA_ROOT =
  /^\/+((data(\/(data|media(\/0)?|user(\/0)?|app|local))?|sdcard|storage(\/emulated(\/0)?|\/self(\/primary)?)?|system|vendor|product|cache|metadata|persist|mnt|efs)\/*(\*|\.)?)?$/i;

/** The adb arguments after the global options (`-s <serial>`, `-d`, ...). */
export function adbCommand(args: readonly string[]): string[] {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) {
    i += VALUED.has(args[i]!) ? 2 : 1;
  }

  return args.slice(i);
}

/**
 * Why an adb command would destroy the device or its data, or undefined. `args` start at the adb command (`shell`,
 * `reboot`, `uninstall`, ...), after any global options. A deliberate short list, not a sandbox: factory reset and
 * wipes, recovery and bootloader modes, `rm -r` of a data root, and removing or resetting system packages.
 */
export function adbDestructive(args: readonly string[]): string | undefined {
  const tokens = args.flatMap((a) => a.split(/[\s;&|()`$<>"']+/)).filter(Boolean);
  const lower = tokens.map((t) => t.toLowerCase());
  if (lower.length === 0) {
    return undefined;
  }

  return (
    riskyReboot(lower) ??
    factoryReset(lower) ??
    dataRootRemoval(tokens, lower) ??
    systemPackageRemoval(lower)
  );
}

function riskyReboot(lower: string[]): string | undefined {
  const mode = lower[1];
  if (lower[0] === "reboot" && mode && REBOOT_MODES.some((m) => mode.startsWith(m))) {
    return `adb reboot ${mode} can leave the device in a mode only a human can undo.`;
  }
}

const isWipe = (t: string): boolean =>
  t.includes("master_clear") || t.includes("factory_reset") || t === "--wipe_data" || t === "wipe";

function factoryReset(lower: string[]): string | undefined {
  if (lower.some(isWipe)) {
    return "Factory reset and data wipes are refused.";
  }

  if (lower[0] === "shell" && lower.includes("recovery")) {
    return "Factory reset and recovery commands are refused.";
  }
}

function dataRootRemoval(tokens: string[], lower: string[]): string | undefined {
  for (let i = 0; i < tokens.length; i++) {
    const root = lower[i] === "rm" ? removedRoot(rmArguments(tokens, lower, i)) : undefined;
    if (root !== undefined) {
      return `rm -r of ${root} would wipe the device's data.`;
    }
  }
}

/** The arguments of the `rm` at `at`: the tokens up to the next `rm` or `shell`. */
function rmArguments(tokens: string[], lower: string[], at: number): string[] {
  const rest: string[] = [];
  for (let j = at + 1; j < tokens.length && !["rm", "shell"].includes(lower[j]!); j++) {
    rest.push(tokens[j]!);
  }

  return rest;
}

/** The data root a recursive `rm` with these arguments removes, if any. */
function removedRoot(rest: string[]): string | undefined {
  const recursive = rest.some((a) => /^-[a-z]*r/i.test(a) || a === "--recursive");

  return recursive ? rest.find((a) => !a.startsWith("-") && DATA_ROOT.test(a)) : undefined;
}

function systemPackageRemoval(lower: string[]): string | undefined {
  const removal = packageRemoval(lower);
  if (!removal) {
    return undefined;
  }

  const pkg = removal.rest.filter((t) => !t.startsWith("-")).at(-1);
  if (
    removal.rest.some((t) => t === "--user" || t.startsWith("--user=")) ||
    pkg === undefined ||
    SYSTEM_PACKAGE.test(pkg)
  ) {
    return `pm ${removal.verb} of a system package (or with --user) is refused; removing an app you installed needs its own package name and no --user.`;
  }
}

/** An `uninstall`, or a `pm`/`package` removal anywhere on the line: its verb and the words after it. */
function packageRemoval(lower: string[]): { verb: string; rest: string[] } | undefined {
  if (lower[0] === "uninstall") {
    return { verb: "uninstall", rest: lower.slice(1) };
  }

  const at = lower.findIndex(
    (t, i) => i > 0 && (t === "pm" || t === "package") && PM_REMOVALS.has(lower[i + 1] ?? ""),
  );

  return at < 0 ? undefined : { verb: lower[at + 1]!, rest: lower.slice(at + 2) };
}

/** Why a fastboot command would wipe or reflash the device, or undefined. */
export function fastbootDestructive(args: readonly string[]): string | undefined {
  const words = args.filter((a) => !a.startsWith("-") || a === "-w");
  const verb = words.find((w) => w !== "-w");
  if (
    args.includes("-w") ||
    ["erase", "format", "flashall", "flash", "oem", "flashing"].includes(verb ?? "")
  ) {
    return `fastboot ${verb ?? "-w"} can wipe or reflash the device.`;
  }

  return undefined;
}
