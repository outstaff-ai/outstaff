import { describe, expect, it } from "vitest";
import { people } from "#/recall/who.js";

const team = {
  humans: [{ name: "Ada Admin", identities: { chat: "U0ADA00001" } }],
  people: [{ handle: "sam", name: "Sam" }],
} as unknown as Parameters<typeof people>[0];

describe("who a moment is with", () => {
  it("names a person by every name and id they appear under", () => {
    const p = people(team);
    expect(p.namesOf("ada")).toEqual(["ada", "Ada Admin", "U0ADA00001"]);
    expect(p.namesOf("Sam")).toEqual(["Sam", "sam"]);
    expect(p.namesOf("someone")).toEqual(["someone"]);
    expect(people({ people: [] } as unknown as typeof team).namesOf("x")).toEqual(["x"]);
  });

  it("shows an actor as the team knows them, else as the integration named them", () => {
    const p = people(team);
    expect(p.shown("u0ada00001", null)).toBe("Ada Admin");
    expect(p.shown("SAM", null)).toBe("sam");
    expect(p.shown("U9", "Bo")).toBe("Bo");
    expect(p.shown("U9", null)).toBe("U9");
    expect(p.shown(null, null)).toBeUndefined();
  });
});
