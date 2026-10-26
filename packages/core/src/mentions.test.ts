import { describe, expect, it } from "vitest";
import { mentionData, parseMentions } from "./mentions.js";

describe("parseMentions", () => {
  it("reads @names in order, once each, without trailing punctuation", () => {
    expect(parseMentions("@lena, please look at this. Then @sam-2! And again @Lena.")).toEqual([
      "lena",
      "sam-2",
    ]);
  });

  it("keeps dots and dashes inside a name", () => {
    expect(parseMentions("ask @anna.k_x-1 now")).toEqual(["anna.k_x-1"]);
  });

  it("ignores emails, scoped packages, code and a bare @", () => {
    expect(
      parseMentions(
        "mail dana@acme.example, install @scope/pkg, run `@lena` or\n```\n@sam\n```\n@",
      ),
    ).toEqual([]);
  });

  it("finds a mention at the start of a line or in brackets", () => {
    expect(parseMentions("(@lena)\n@sam")).toEqual(["lena", "sam"]);
  });

  it("mentionData is empty when nobody is named", () => {
    expect(mentionData("hello")).toEqual({});
    expect(mentionData(undefined)).toEqual({});
    expect(mentionData("hi @lena")).toEqual({ mentions: ["lena"] });
  });
});
