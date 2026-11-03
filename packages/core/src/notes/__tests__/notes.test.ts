import { describe, expect, it } from "vitest";
import type { Member, TeamConfig } from "#/index.js";
import { noteId, notesTrust, parseNotes, renderNotes, toNote, trackerActors } from "#/index.js";

describe("parseNotes", () => {
  it("reads one note per top-level item, with its continuation lines", () => {
    const md = [
      "# Lessons",
      "",
      "- Run the tests",
      "  before pushing.",
      "  - even for docs",
      "* Ask before renaming.",
      "1. Numbered works too.",
      "",
      "A paragraph is a note",
      "over two lines.",
      "- Run the tests before pushing. - even for docs",
      "",
    ].join("\n");

    expect(parseNotes(md)).toEqual([
      "Run the tests before pushing. - even for docs",
      "Ask before renaming.",
      "Numbered works too.",
      "A paragraph is a note over two lines.",
    ]);
  });

  it("reads nothing from an empty or heading-only text", () => {
    expect(parseNotes("")).toEqual([]);
    expect(parseNotes("## Notes\n\n-   \n")).toEqual([]);
  });

  it("renders a list that parses back to the same notes", () => {
    const notes = ["One  thing\nper line", "Two"];
    expect(renderNotes(notes)).toBe("- One thing per line\n- Two\n");
    expect(parseNotes(renderNotes(notes))).toEqual(["One thing per line", "Two"]);
    expect(renderNotes([])).toBe("");
  });

  it("gives the same text the same short id", () => {
    expect(noteId("Ask  first")).toBe(noteId("Ask first"));
    expect(noteId("Ask first")).toMatch(/^[0-9a-f]{8}$/);
    expect(toNote(" Ask first ")).toEqual({ id: noteId("Ask first"), text: "Ask first" });
  });
});

const member = (over: Partial<Member>): Member => ({
  id: "u1",
  name: "Someone",
  kind: "human",
  ...over,
});

const team = (humans?: TeamConfig["humans"]) =>
  ({
    ...(humans ? { humans } : {}),
    people: [
      { handle: "sam", identities: { tracker: "sam" } },
      { handle: "pia", identities: {} },
    ],
  }) as unknown as TeamConfig;

describe("trackerActors", () => {
  it("knows the team's agents by tracker identity and other agent accounts as automation", () => {
    const actor = trackerActors(team());
    expect(actor(member({ id: "x", username: "sam", kind: "agent" }))).toEqual({
      kind: "agent",
      id: "sam",
      trusted: false,
    });

    expect(actor(member({ id: "bot", kind: "agent" }))).toEqual({
      kind: "automation",
      id: "bot",
      trusted: false,
    });
  });

  it("trusts the humans the team names, or every human without a list", () => {
    const named = trackerActors(team([{ name: "Ada", identities: { tracker: "Ada.Admin" } }]));
    expect(named(member({ username: "ada.admin" })).trusted).toBe(true);
    expect(named(member({ username: "rio" })).trusted).toBe(false);
    expect(trackerActors(team())(member({ username: "rio" })).trusted).toBe(true);
  });
});

describe("notesTrust", () => {
  const trusted = notesTrust(team([{ name: "Ada", identities: { tracker: "ada" } }]), "sam");

  it("uses the agent's own versions and a trusted human's", () => {
    expect(trusted(member({ username: "sam", kind: "agent" }))).toBe(true);
    expect(trusted(member({ username: "ada" }))).toBe(true);
  });

  it("recognizes its own account by handle when the team names no tracker identity", () => {
    const pia = notesTrust(team(), "pia");
    expect(pia(member({ username: "pia", kind: "agent" }))).toBe(true);
  });

  it("ignores other agents, automation and untrusted humans", () => {
    expect(trusted(member({ username: "sam", kind: "agent" }))).toBe(true);
    expect(notesTrust(team(), "pia")(member({ username: "sam", kind: "agent" }))).toBe(false);
    expect(trusted(member({ username: "ci", kind: "agent" }))).toBe(false);
    expect(trusted(member({ username: "rio" }))).toBe(false);
  });
});
