import { spawnSync } from "node:child_process";

// With CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 on Linux, Claude Code runs every Bash command in bubblewrap with its own user
// and PID namespaces and a fresh /proc, so a command cannot read the credential from /proc/<pid>/environ. Claude Code
// only checks that bwrap exists; when the container blocks it, every Bash call fails instead. This probe runs bwrap
// the way Claude Code does and names what the container is missing.

export interface SandboxProbe {
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface ProbeResult {
  /** Exit status; null when the command could not start or was killed. */
  status: number | null;
  stderr: string;

  /** Set when the command could not start, for example ENOENT. */
  errorCode?: string;
}

export type ProbeSpawn = (command: string, args: readonly string[]) => ProbeResult;

const GUIDE = "https://docs.outstaff.work/guides/kubernetes/#subprocess-sandbox-optional";

/** The namespaces and /proc handling Claude Code 2.1.308 uses for each Bash command in scrub mode. */
export const BWRAP_PROBE_ARGS = [
  "--unshare-user",
  "--unshare-pid",
  "--ro-bind",
  "/",
  "/",
  "--proc",
  "/proc",
  "--disable-userns",
  "true",
] as const;

const SECCOMP_FIX =
  "Run the agent with the outstaff-bwrap seccomp profile: in Kubernetes, seccompProfile Localhost outstaff/bwrap.json on the pod; in Compose, security_opt seccomp=./seccomp/outstaff-bwrap.json.";

const CAUSES: { test: RegExp; detail: string; fix: string }[] = [
  {
    test: /No permissions to create new namespace|Creating new namespace failed|unshare user ns|setting up uid map/i,
    detail:
      "bubblewrap cannot create a user namespace: the container's seccomp profile (or AppArmor) blocks it.",
    fix: SECCOMP_FIX,
  },
  {
    test: /Can't mount proc/i,
    detail:
      "/proc is masked, so bubblewrap cannot mount a fresh /proc for the command's PID namespace.",
    fix: "In Kubernetes, set hostUsers: false on the pod and procMount: Unmasked on the agent container. In Compose, add security_opt systempaths=unconfined.",
  },
  {
    test: /make \/ slave|pivot_root|unmount old root|mount/i,
    detail:
      "bubblewrap cannot build its mounts: the seccomp profile or AppArmor blocks mount, umount2 or pivot_root.",
    fix: `${SECCOMP_FIX} On a host that enforces AppArmor, also apply the outstaff-bwrap AppArmor profile.`,
  },
  {
    test: /max_user_namespaces|Permission denied/i,
    detail:
      "bubblewrap cannot limit nested user namespaces inside the sandbox: AppArmor denies the write to /proc/sys/user.",
    fix: "On a host that enforces AppArmor, apply the outstaff-bwrap AppArmor profile to the agent container.",
  },
];

const defaultSpawn: ProbeSpawn = (command, args) => {
  const r = spawnSync(command, args, { encoding: "utf8", timeout: 5_000 });
  const errorCode = (r.error as NodeJS.ErrnoException | undefined)?.code;
  return { status: r.status, stderr: r.stderr ?? "", ...(errorCode ? { errorCode } : {}) };
};

/** Runs bwrap as Claude Code does. Off Linux, Claude Code does not use bubblewrap and there is nothing to check. */
export function probeSubprocessSandbox(
  spawn: ProbeSpawn = defaultSpawn,
  platform: NodeJS.Platform = process.platform,
): SandboxProbe {
  if (platform !== "linux") {
    return { ok: true, detail: `Claude Code does not use bubblewrap on ${platform}.` };
  }

  for (const [tool, args] of [
    ["bwrap", ["--version"]],
    ["socat", ["-V"]],
  ] as const) {
    if (spawn(tool, args).errorCode === "ENOENT") {
      return {
        ok: false,
        detail: `${tool} is not installed. Claude Code needs bubblewrap and socat to run the agent's commands in its sandbox.`,
        fix: `Use the agent image built from images/Dockerfile (target agent), which has both. See ${GUIDE}`,
      };
    }
  }

  const r = spawn("bwrap", BWRAP_PROBE_ARGS);
  if (r.status === 0) {
    return { ok: true, detail: "bubblewrap runs with user and PID namespaces and a fresh /proc." };
  }

  const said = r.stderr.trim().split("\n")[0] || `exit status ${r.status}`;
  const cause = CAUSES.find((c) => c.test.test(said));
  return {
    ok: false,
    detail: `${cause?.detail ?? "bubblewrap does not run."} bwrap said: ${said}`,
    fix: `${cause?.fix ?? "Check the container's seccomp profile, AppArmor profile and /proc mount."} See ${GUIDE}`,
  };
}
