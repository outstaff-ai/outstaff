import type { CommandRule } from "./types.js";

/** Programs that change the user the command runs as, or leave the sandbox's view of the system. */
const PRIVILEGE_TOOLS = [
  "sudo",
  "doas",
  "su",
  "pkexec",
  "runuser",
  "nsenter",
  "chroot",
  "setpriv",
  "capsh",
];

/** Infrastructure writes, denied unless a tool declaration or team rule allows the program. */
const INFRA_WRITES: { program: string; verbs: string[]; sub?: Record<string, string> }[] = [
  {
    program: "kubectl",
    verbs: [
      "apply",
      "create",
      "delete",
      "edit",
      "patch",
      "replace",
      "scale",
      "autoscale",
      "set",
      "label",
      "annotate",
      "taint",
      "cordon",
      "uncordon",
      "drain",
      "expose",
      "run",
      "exec",
      "cp",
      "debug",
      "attach",
      "certificate",
    ],
    sub: { rollout: "^(restart|undo|pause|resume)$" },
  },
  { program: "helm", verbs: ["install", "upgrade", "uninstall", "delete", "rollback"] },
  ...["terraform", "tofu"].map((program) => ({
    program,
    verbs: ["apply", "destroy", "import", "taint", "untaint", "force-unlock"],
    sub: { state: "^(rm|mv|push|replace-provider)$" },
  })),
  {
    program: "pulumi",
    verbs: ["up", "update", "destroy", "refresh", "import", "cancel"],
    sub: { stack: "^(rm|remove)$" },
  },
];

const rule = (r: CommandRule): CommandRule => r;

/** The built-in command rules: privilege tools are denied, infrastructure writes are denied by default. */
export function commandRules(): CommandRule[] {
  const rules: CommandRule[] = PRIVILEGE_TOOLS.map((program) =>
    rule({
      id: `privilege.${program}`,
      program,
      effect: "deny",
      reason: `${program} runs commands with other privileges.`,
    }),
  );

  for (const { program, verbs, sub } of INFRA_WRITES) {
    const reason = (what: string) =>
      `${program} ${what} changes infrastructure; it runs only when a tools declaration or team rule allows ${program}.`;

    for (const verb of verbs) {
      rules.push(
        rule({
          id: `infra.${program}.${verb}`,
          program,
          subcommand: [verb],
          effect: "deny",
          fallback: true,
          reason: reason(verb),
        }),
      );
    }

    for (const [word, pattern] of Object.entries(sub ?? {})) {
      rules.push(
        rule({
          id: `infra.${program}.${word}`,
          program,
          subcommand: [word],
          args: [{ kind: "positional", index: 0, pattern }],
          effect: "deny",
          fallback: true,
          reason: reason(word),
        }),
      );
    }
  }

  return rules;
}
