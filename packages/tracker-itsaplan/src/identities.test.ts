import { WARNING_CODES, type TeamConfig } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { validateItsaplanIdentities } from "./identities.js";

const team = (human: string, person?: string) =>
  ({
    humans: [{ name: "Alex", identities: { tracker: human } }],
    people: [{ handle: "sam", identities: person === undefined ? {} : { tracker: person } }],
  }) as unknown as TeamConfig;

describe("validateItsaplanIdentities", () => {
  it("accepts usernames and ids", () => {
    expect(validateItsaplanIdentities(team("alex", "u-2"))).toEqual([]);
  });

  it("flags blank identities with their path", () => {
    const out = validateItsaplanIdentities(team("  ", " "));
    expect(out.map((w) => [w.path, w.code])).toEqual([
      [["humans", 0, "identities", "tracker"], WARNING_CODES.identityTrackerEmpty],
      [["people", 0, "identities", "tracker"], WARNING_CODES.identityTrackerEmpty],
    ]);
  });
});
