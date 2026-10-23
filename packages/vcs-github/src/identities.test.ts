import { WARNING_CODES, type TeamConfig } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { validateGithubIdentities } from "./identities.js";

const team = (humans: string[], people: (string | undefined)[]) =>
  ({
    humans: humans.map((vcs, i) => ({ name: `h${i}`, identities: { vcs } })),
    people: people.map((vcs, i) => ({ handle: `p${i}`, identities: vcs ? { vcs } : {} })),
  }) as unknown as TeamConfig;

describe("validateGithubIdentities", () => {
  it("accepts logins for humans and App bot logins for people", () => {
    expect(
      validateGithubIdentities(team(["alex", "alex-b2", "a"], ["acme-sam[bot]", undefined])),
    ).toEqual([]);
  });

  it("flags non-logins for humans with a located path", () => {
    const out = validateGithubIdentities(
      team(["alex", "Alex Doe", "alex@acme.example", "-alex", "x[bot]"], []),
    );

    expect(out.map((w) => [w.path, w.code])).toEqual(
      [1, 2, 3, 4].map((i) => [
        ["humans", i, "identities", "vcs"],
        WARNING_CODES.identityVcsNotLogin,
      ]),
    );
  });

  it("flags people whose login is not an App bot login", () => {
    const out = validateGithubIdentities(team([], ["acme-sam[bot]", "acme-sam", "sam [bot]"]));
    expect(out.map((w) => [w.path, w.code])).toEqual([
      [["people", 1, "identities", "vcs"], WARNING_CODES.identityVcsNotBotLogin],
      [["people", 2, "identities", "vcs"], WARNING_CODES.identityVcsNotBotLogin],
    ]);
  });
});
