import { envSecretSource } from "@outstaff/core";
import { describe, expect, it, vi } from "vitest";
import { claudeAgentSdk } from "./adapter.js";
import { bubblewrapMissing } from "./sandbox.js";

const ctx = (sandbox: "off" | "bubblewrap") =>
  ({
    options: claudeAgentSdk.options.parse({ sandbox }),
    secrets: envSecretSource({}, "/nonexistent"),
  }) as never;

describe("bubblewrapMissing", () => {
  it("is quiet when bwrap runs, and off Linux, where Claude Code does not use it", () => {
    expect(bubblewrapMissing("linux", () => true)).toBeUndefined();
    const run = vi.fn<(command: string) => boolean>(() => false);
    expect(bubblewrapMissing("darwin", run)).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("names the packages, the pod and the guide when bwrap is missing on Linux", () => {
    expect(bubblewrapMissing("linux", () => false)).toMatch(
      /^sandbox: bubblewrap needs the bubblewrap and socat packages and a pod that allows user namespaces; see https:\/\/docs\.outstaff\.work\//,
    );
  });
});

describe("runtime creation", () => {
  it("does not look for bubblewrap with sandbox: off", () => {
    expect(() => claudeAgentSdk.create(ctx("off"))).not.toThrow();
  });

  it.runIf(process.platform === "linux")(
    "stops at start with sandbox: bubblewrap when bwrap is missing",
    () => {
      const path = process.env["PATH"];
      process.env["PATH"] = "/nonexistent";
      try {
        expect(() => claudeAgentSdk.create(ctx("bubblewrap"))).toThrow(/sandbox: bubblewrap needs/);
      } finally {
        process.env["PATH"] = path;
      }
    },
  );
});
