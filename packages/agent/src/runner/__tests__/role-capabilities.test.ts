import type { Capability, TeamConfig } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { roleCapabilities } from "#/runner/startup-work.js";
import type { RuntimeAdapter, StartupContext } from "#/runner/startup.types.js";

const roles = {
  designer: {
    needs: ["runtime.sessions", "tracker.issues"],
    optional_needs: ["design.canvas", "runtime.usage"],
  },
  developer: { needs: ["runtime.sessions", "vcs.pullRequests"], optional_needs: [] },
};

const context = (policies?: TeamConfig["policies"]) =>
  ({
    team: { policies },
    me: { handle: "leo", role: "designer" },
  }) as unknown as StartupContext;

const runtime = (capabilities: Capability[]) => ({ capabilities }) as unknown as RuntimeAdapter;

describe("roleCapabilities", () => {
  it("returns the declared runtime capabilities the runtime provides, once each", () => {
    const caps = roleCapabilities(
      context(),
      roles,
      ["developer"],
      runtime(["runtime.sessions", "design.canvas", "runtime.permissions"]),
    );

    expect(caps).toEqual(["runtime.sessions", "design.canvas"]);
  });

  it("leaves out one the runtime does not provide, and capabilities of other ports", () => {
    // tracker.issues is declared and even listed by the runtime, but it is not a runtime capability.
    const caps = roleCapabilities(
      context(),
      roles,
      undefined,
      runtime(["runtime.usage", "tracker.issues"]),
    );

    expect(caps).toEqual(["runtime.usage"]);
  });

  it("leaves out one the team switched off", () => {
    const off = { design: { canvas: false } } as unknown as TeamConfig["policies"];
    const caps = roleCapabilities(context(off), roles, undefined, runtime(["design.canvas"]));
    expect(caps).toEqual([]);
  });
});
