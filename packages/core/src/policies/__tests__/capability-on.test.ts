import { describe, expect, it } from "vitest";
import { capabilityOn } from "#/policies/capability-on.js";

describe("capabilityOn", () => {
  it("is off only when the switch named like the capability is off", () => {
    expect(capabilityOn(undefined, "design.canvas")).toBe(true);
    expect(capabilityOn({ design: { canvas: true } }, "design.canvas")).toBe(true);
    expect(capabilityOn({ design: { canvas: false } }, "design.canvas")).toBe(false);
  });

  it("keeps a capability without a switch on", () => {
    expect(capabilityOn({ design: { canvas: false } }, "runtime.usage")).toBe(true);
    expect(capabilityOn(undefined, "vcs.merge")).toBe(true);
  });
});
