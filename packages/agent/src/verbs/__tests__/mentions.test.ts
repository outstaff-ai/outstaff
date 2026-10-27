import { describe, expect, it } from "vitest";
import { PortError } from "@outstaff/core";
import { mentionGuard } from "#/verbs/mentions.js";
import { acmeTeam } from "@outstaff/testing.agent";

const guard = mentionGuard(acmeTeam());
const apply = (s: string) => guard.apply(s);

describe("mention guard", () => {
  it("rewrites a teammate's handle to their name, in any case and with the bot login", () => {
    expect(apply("Thanks @sam, and @Mira and @acme-noor[bot].")).toBe(
      "Thanks Sam, and Mira and Noor.",
    );
  });

  it("keeps a configured human's code-host username and refuses everyone else", () => {
    expect(apply("cc @ada-admin and @Grace-Lead")).toBe("cc @ada-admin and @Grace-Lead");
    let error: unknown;
    try {
      apply("ping @stranger and @other-one, ok @ada-admin");
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(PortError);
    expect((error as PortError).code).toBe("invalid");
    expect((error as PortError).message).toContain("@stranger, @other-one");
    expect((error as PortError).message).toContain("@ada-admin");
    expect((error as PortError).message).not.toContain("@sam");
  });

  it("leaves code spans, fenced blocks, emails, scoped packages and URLs alone", () => {
    const text = [
      "Use `@stranger` or ``a `@x` b``.",
      "Mail dev@stranger.example, install @acme/ui, see https://git.acme.example/@stranger.",
      "```ts",
      "import x from '@stranger/pkg'; // @sam",
      "```",
      "~~~",
      "@someone",
      "~~~",
      "Done.",
    ].join("\n");

    expect(apply(text)).toBe(text);
  });

  it("guards the text around code, not inside it", () => {
    expect(apply("`@x` then @sam\n```\n@y\n```\nafter @leo")).toBe(
      "`@x` then Sam\n```\n@y\n```\nafter Leo",
    );
  });

  it("refuses a mention after an unclosed fence ends, and handles an unclosed fence as code", () => {
    expect(apply("```\n@stranger never closed")).toBe("```\n@stranger never closed");
    expect(() => apply("```\ncode\n```\n@stranger")).toThrow(PortError);
  });

  it("returns text without an @ unchanged", () => {
    expect(apply("plain")).toBe("plain");
  });
});
