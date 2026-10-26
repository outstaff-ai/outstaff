/** adb options before the command that take a value. */
const VALUED = new Set(["-s", "-t", "-H", "-P", "-L"]);

/** Package names of the platform itself, whose removal or reset can break the device. */
const SYSTEM_PACKAGE = /^(android|com\.android\.|com\.google\.)/i;
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
  const first = lower[0];
  if (first === undefined) {
    return undefined;
  }

  if (
    first === "reboot" &&
    lower[1] &&
    ["bootloader", "recovery", "sideload", "fastboot"].some((m) => lower[1]!.startsWith(m))
  ) {
    return `adb reboot ${lower[1]} can leave the device in a mode only a human can undo.`;
  }

  if (
    lower.some(
      (t) =>
        t.includes("master_clear") ||
        t.includes("factory_reset") ||
        t === "--wipe_data" ||
        t === "wipe",
    )
  ) {
    return "Factory reset and data wipes are refused.";
  }

  if (first === "shell" && lower.includes("recovery")) {
    return "Factory reset and recovery commands are refused.";
  }

  for (let i = 0; i < tokens.length; i++) {
    if (lower[i] !== "rm") {
      continue;
    }

    const rest: string[] = [];
    for (let j = i + 1; j < tokens.length && !["rm", "shell"].includes(lower[j]!); j++) {
      rest.push(tokens[j]!);
    }

    const recursive = rest.some((a) => /^-[a-z]*r/i.test(a) || a === "--recursive");
    const root = rest.find((a) => !a.startsWith("-") && DATA_ROOT.test(a));
    if (recursive && root !== undefined) {
      return `rm -r of ${root} would wipe the device's data.`;
    }
  }

  const at =
    first === "uninstall"
      ? 0
      : lower.findIndex(
          (t, i) => i > 0 && (t === "pm" || t === "package") && PM_REMOVALS.has(lower[i + 1] ?? ""),
        );

  if (at >= 0) {
    const rest = first === "uninstall" ? lower.slice(1) : lower.slice(at + 2);
    const verb = first === "uninstall" ? "uninstall" : lower[at + 1]!;
    const pkg = rest.filter((t) => !t.startsWith("-")).at(-1);
    if (
      rest.some((t) => t === "--user" || t.startsWith("--user=")) ||
      pkg === undefined ||
      SYSTEM_PACKAGE.test(pkg)
    ) {
      return `pm ${verb} of a system package (or with --user) is refused; removing an app you installed needs its own package name and no --user.`;
    }
  }

  return undefined;
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
