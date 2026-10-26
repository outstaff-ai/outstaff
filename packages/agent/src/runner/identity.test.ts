import { describe, expect, it } from "vitest";
import { acmeTeam } from "../verbs/testing.js";
import { buildIdentityPrompt } from "./identity.js";

describe("identity prompt", () => {
  const team = acmeTeam();
  const role = { title: "Developer", summary: "Implements tickets." };

  it("names the person, role, team, product and humans", () => {
    const text = buildIdentityPrompt({ team, handle: "sam", role });
    expect(text).toContain("You are Sam Duarte (@sam, they/them), the Developer of the acme team");
    expect(text).toContain("which builds Acme Shop");
    expect(text).toContain("Your role: Implements tickets.");
    expect(text).toContain("Ada Admin, Grace Lead");
    expect(text).toContain("Priya Raman (@priya, pm)");
    expect(text).not.toContain("Sam Duarte (@sam, developer)");
  });

  it("states the message style from policies.messages", () => {
    const text = buildIdentityPrompt({ team, handle: "sam", role });
    expect(text).toContain("about 3 lines");
    expect(text).toContain("Always link tickets, pull requests and documents");
    expect(text).toContain("Leave out: CI status, mergeability, commit hashes.");
  });

  it("follows a changed policy", () => {
    const changed = structuredClone(team);
    changed.policies = {
      ...changed.policies!,
      messages: { max_lines: 5, always_link: false, omit: ["file_lists"] },
    };

    const text = buildIdentityPrompt({ team: changed, handle: "sam", role });
    expect(text).toContain("about 5 lines");
    expect(text).not.toContain("Always link");
    expect(text).toContain("Leave out: lists of changed files.");
  });

  it("explains who is trusted when the team lists no humans", () => {
    const changed = { ...structuredClone(team), humans: [] };
    expect(buildIdentityPrompt({ team: changed, handle: "sam" })).toContain(
      "write access to the team's repositories",
    );
  });

  it("falls back to the role name and rejects an unknown person", () => {
    expect(buildIdentityPrompt({ team, handle: "sam" })).toContain("the developer of");
    expect(() => buildIdentityPrompt({ team, handle: "nobody" })).toThrow(/not a person/);
  });
});
