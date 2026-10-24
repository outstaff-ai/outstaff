import { describe, expect, it } from "vitest";
import {
  BWRAP_PROBE_ARGS,
  probeSubprocessSandbox,
  type ProbeResult,
  type ProbeSpawn,
} from "./sandbox.js";

/** A spawn that answers `bwrap <probe args>` with `probe` and every version check with success. */
function spawnWith(probe: ProbeResult, missing?: string) {
  const calls: string[][] = [];
  const spawn: ProbeSpawn = (command, args) => {
    calls.push([command, ...args]);
    if (command === missing) {
      return { status: null, stderr: "", errorCode: "ENOENT" };
    }

    return args.includes("--unshare-user") ? probe : { status: 0, stderr: "" };
  };

  return { spawn, calls };
}

const failing = (stderr: string) => spawnWith({ status: 1, stderr: `bwrap: ${stderr}\n` }).spawn;

describe("probeSubprocessSandbox", () => {
  it("has nothing to check off Linux", () => {
    const { spawn, calls } = spawnWith({ status: 1, stderr: "" });
    expect(probeSubprocessSandbox(spawn, "darwin").ok).toBe(true);
    expect(calls).toEqual([]);
  });

  it("runs bwrap with Claude Code's namespaces and a fresh /proc", () => {
    const { spawn, calls } = spawnWith({ status: 0, stderr: "" });
    expect(probeSubprocessSandbox(spawn, "linux")).toMatchObject({ ok: true });
    expect(calls).toContainEqual(["bwrap", ...BWRAP_PROBE_ARGS]);
    expect(BWRAP_PROBE_ARGS).toEqual(
      expect.arrayContaining(["--unshare-user", "--unshare-pid", "--proc", "--disable-userns"]),
    );
  });

  it.each(["bwrap", "socat"])("names %s when it is not installed", (tool) => {
    const p = probeSubprocessSandbox(spawnWith({ status: 0, stderr: "" }, tool).spawn, "linux");
    expect(p.ok).toBe(false);
    expect(p.detail).toContain(`${tool} is not installed`);
    expect(p.fix).toContain("images/Dockerfile");
  });

  it.each([
    [
      "No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces.",
      /cannot create a user namespace/,
      /seccomp/,
    ],
    ["unshare user ns: Operation not permitted", /cannot create a user namespace/, /seccomp/],
    [
      "Can't mount proc on /newroot/proc: Operation not permitted",
      /\/proc is masked/,
      /procMount: Unmasked/,
    ],
    ["Failed to make / slave: Permission denied", /cannot build its mounts/, /AppArmor/],
    ["pivot_root: Operation not permitted", /cannot build its mounts/, /seccomp/],
    [
      "cannot open /proc/sys/user/max_user_namespaces: Permission denied",
      /nested user namespaces/,
      /AppArmor/,
    ],
  ])("explains %s", (stderr, detail, fix) => {
    const p = probeSubprocessSandbox(failing(stderr), "linux");
    expect(p.ok).toBe(false);
    expect(p.detail).toMatch(detail);
    expect(p.detail).toContain(stderr.split(",")[0]);
    expect(p.fix).toMatch(fix);
    expect(p.fix).toContain("docs.outstaff.work");
  });

  it("still reports an unknown failure with what bwrap said", () => {
    const p = probeSubprocessSandbox(failing("something new"), "linux");
    expect(p).toMatchObject({ ok: false });
    expect(p.detail).toContain("bwrap: something new");
  });
});
