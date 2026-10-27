import { describe, expect, it } from "vitest";
import { failedStepNames, failedSteps, keyParts } from "#/check-log.js";

describe("failedStepNames", () => {
  it("keeps failed and timed out steps only", () => {
    expect(
      failedStepNames([
        { name: "setup", conclusion: "success" },
        { name: "build", conclusion: "failure" },
        { name: "test", conclusion: "timed_out" },
        { name: "lint", conclusion: null },
        { name: "deploy", conclusion: "skipped" },
      ]),
    ).toEqual(["build", "test"]);
  });
});

describe("failedSteps", () => {
  const ts = "2026-01-01T00:00:00.123Z ";

  it("takes the segments that hold an error line, stripping timestamps and colours", () => {
    const log = [
      `${ts}##[group]Run build`,
      `${ts}##[endgroup]`,
      `${ts}\u001b[31mboom\u001b[0m`,
      `${ts}##[error]Process completed with exit code 1.`,
      "",
      "",
    ].join("\r\n");

    expect(failedSteps(log, ["build"], 10)).toEqual([
      {
        name: "build",
        lines: ["boom", "##[error]Process completed with exit code 1."],
        omitted: 0,
      },
    ]);
  });

  it("keeps the last lines and counts the omitted ones", () => {
    const log = ["##[group]build", "a", "b", "c", "##[error]x"].join("\n");
    expect(failedSteps(log, ["build"], 2)).toEqual([
      { name: "build", lines: ["c", "##[error]x"], omitted: 2 },
    ]);
  });

  it("falls back to the segment titled like a failed step when no error line exists", () => {
    const log = ["pre", "##[group]build", "out", "##[group]other", "more"].join("\n");
    expect(failedSteps(log, ["build"], 10)).toEqual([
      { name: "build", lines: ["out"], omitted: 0 },
    ]);
  });

  it("falls back to the whole log under the first failed step name", () => {
    const log = ["first", "second"].join("\n");
    expect(failedSteps(log, ["build", "test"], 10)).toEqual([
      { name: "build", lines: ["first", "second"], omitted: 0 },
    ]);
  });

  it("returns nothing when no step failed and the log has no error", () => {
    expect(failedSteps("just output", [], 10)).toEqual([]);
  });

  it("names error segments after the failed steps in order when the counts match", () => {
    const log = ["##[group]Run a", "##[error]x", "##[group]Run b", "##[error]y"].join("\n");
    expect(failedSteps(log, ["alpha", "beta"], 10).map((s) => s.name)).toEqual(["alpha", "beta"]);
  });

  it("names an error segment by its own title when counts differ, or the first failed step, or log", () => {
    const titled = ["##[group]Run a", "##[error]x"].join("\n");
    expect(failedSteps(titled, ["alpha", "beta"], 10).map((s) => s.name)).toEqual(["Run a"]);

    const untitled = "##[error]x";
    expect(failedSteps(untitled, ["alpha", "beta"], 10).map((s) => s.name)).toEqual(["alpha"]);
    expect(failedSteps(untitled, [], 10).map((s) => s.name)).toEqual(["log"]);
  });
});

describe("keyParts", () => {
  it("is the key and each line of its body, without the armour or blank lines", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\r\nAAAA1111\nBBBB2222\n-----END PRIVATE KEY-----\n";
    expect(keyParts(pem)).toEqual([pem, "AAAA1111", "BBBB2222"]);
  });
});
