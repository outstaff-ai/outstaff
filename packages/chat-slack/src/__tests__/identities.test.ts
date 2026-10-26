import { WARNING_CODES, type TeamConfig } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { validateSlackIdentities } from "../identities.js";

const team = (humans: string[], agent?: string) =>
  ({
    humans: humans.map((chat, i) => ({ name: `h${i}`, identities: { chat } })),
    people: [
      { handle: "ada", identities: {} },
      { handle: "sam", identities: agent ? { chat: agent } : {} },
    ],
  }) as unknown as TeamConfig;

describe("validateSlackIdentities", () => {
  it("accepts member ids", () => {
    expect(validateSlackIdentities(team(["U0123ABCD", "W0123ABCDE"], "U9ZZZZZZZ"))).toEqual([]);
  });

  it("locates a name or lowercase id in humans and people", () => {
    const out = validateSlackIdentities(team(["U0123ABCD", "alex", "u0123abcd"], "@sam"));
    expect(out.map((w) => [w.path, w.code])).toEqual([
      [["humans", 1, "identities", "chat"], WARNING_CODES.identityChatNotMemberId],
      [["humans", 2, "identities", "chat"], WARNING_CODES.identityChatNotMemberId],
      [["people", 1, "identities", "chat"], WARNING_CODES.identityChatNotMemberId],
    ]);

    expect(out[0]!.consequence).toContain("h1");
  });
});
