import { describe, expect, it } from "vitest";
import { runningVersion } from "#/version.js";

describe("runningVersion", () => {
  it("reports the image's version over the package's", () => {
    expect(runningVersion({ OUTSTAFF_VERSION: "0.1.0-rc.20" }, "0.0.0")).toBe("0.1.0-rc.20");
  });

  it("falls back to the package's version when the variable is unset or empty", () => {
    expect(runningVersion({}, "0.0.0")).toBe("0.0.0");
    expect(runningVersion({ OUTSTAFF_VERSION: "" }, "0.0.0")).toBe("0.0.0");
  });
});
