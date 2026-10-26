import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnSync = vi.hoisted(() => vi.fn<(command: string, args: readonly string[]) => unknown>());
vi.mock("node:child_process", () => ({ spawnSync }));
const { probeSubprocessSandbox } = await import("../sandbox.js");

beforeEach(() => spawnSync.mockReset());

describe("the real bwrap probe", () => {
  it("runs bwrap and socat with a timeout and reports success", () => {
    spawnSync.mockReturnValue({ status: 0, stderr: "" });
    expect(probeSubprocessSandbox(undefined, "linux")).toMatchObject({ ok: true });
    expect(spawnSync).toHaveBeenCalledWith("bwrap", ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
    });

    expect(spawnSync.mock.calls.map((c) => c[0])).toEqual(["bwrap", "socat", "bwrap"]);
  });

  it("reports a missing binary from the spawn error code", () => {
    spawnSync.mockReturnValue({ status: null, stderr: null, error: { code: "ENOENT" } });
    const probe = probeSubprocessSandbox(undefined, "linux");
    expect(probe).toMatchObject({ ok: false });
    expect(probe.detail).toContain("bwrap is not installed");
  });

  it("falls back to the exit status when bwrap says nothing", () => {
    spawnSync
      .mockReturnValueOnce({ status: 0, stderr: "" })
      .mockReturnValueOnce({ status: 0, stderr: "" })
      .mockReturnValueOnce({ status: 3, stderr: "  \n" });

    const probe = probeSubprocessSandbox(undefined, "linux");
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain("bwrap said: exit status 3");
  });

  it("treats a missing stderr as empty", () => {
    spawnSync
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: null });

    expect(probeSubprocessSandbox(undefined, "linux").detail).toContain(
      "bwrap said: exit status null",
    );
  });
});
