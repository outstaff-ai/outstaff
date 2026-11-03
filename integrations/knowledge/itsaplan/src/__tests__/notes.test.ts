import { PortError, silentLogger, type Member, type NotesOwner } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { API_KEY, secretMap, team } from "@outstaff/testing.itsaplan";
import { createItsaplanFake } from "./fake.js";
import { knowledgeOptions, NOTES_ROOT } from "#/index.js";
import { createItsaplanKnowledge } from "#/knowledge.js";

const setup = async () => {
  const fake = createItsaplanFake();
  const kb = await createItsaplanKnowledge({
    options: knowledgeOptions.parse({}),
    secrets: secretMap({ ITSAPLAN_API_KEY: API_KEY }),
    team,
    log: silentLogger,
    fetch: fake.fetch,
    now: () => new Date("2026-01-01T00:00:00Z"),
  });

  return { fake, notes: kb.notes!, docs: fake.state.docs };
};

/** Trusts the caller (Sam Duarte, `u-sam`) only. */
const owner = (name: string, seen: Member[] = []): NotesOwner => ({
  name,
  trusted: (m) => {
    seen.push(m);
    return m.id === "u-sam";
  },
});

describe("itsaplan notes", () => {
  it("keeps every agent's page public, under one root, owned by the agent", async () => {
    const { notes, docs } = await setup();
    await notes.write(owner("Sam Duarte"), ["One."], undefined);
    const pia = await notes.write(owner("Pia Novak"), ["Two."], undefined);

    const root = docs.filter((d) => d.title === NOTES_ROOT);
    expect(root).toHaveLength(1);
    expect(docs.filter((d) => d.parentId === root[0]!.id).map((d) => d.title)).toEqual([
      "Sam Duarte",
      "Pia Novak",
    ]);

    expect(docs.every((d) => !d.isPrivate && d.ownerUserId === "u-sam")).toBe(true);
    expect(pia.doc).toMatchObject({ title: "Pia Novak", url: expect.stringMatching(/^https:/) });
    expect(docs.find((d) => d.title === "Pia Novak")?.content).toBe("- Two.\n");
  });

  it("reads the oldest root and page when two were made at once", async () => {
    const { notes, docs } = await setup();
    await notes.write(owner("Sam Duarte"), ["First."], undefined);
    const [root, page] = docs;
    docs.push(
      { ...root!, id: 50 },
      { ...page!, id: 51, parentId: 50, content: "- Other root." },
      { ...page!, id: 52, content: "- Later page." },
    );

    expect((await notes.read(owner("Sam Duarte"))).notes).toEqual(["First."]);
  });

  it("falls back to the creator, and treats an unnamed author or empty text as nothing", async () => {
    const { notes, docs } = await setup();
    const sam = owner("Sam Duarte");
    await notes.write(sam, ["Kept."], undefined);
    const page = docs.find((d) => d.title === "Sam Duarte")!;

    page.updatedByUserId = null;
    expect((await notes.read(sam)).notes).toEqual(["Kept."]);

    page.content = null;
    expect((await notes.read(sam)).notes).toEqual([]);

    page.createdByUserId = null;
    const seen: Member[] = [];
    const read = await notes.read(owner("Sam Duarte", seen));
    expect(read.ignored?.author).toEqual({ id: "unknown", name: "unknown", kind: "human" });
    expect(seen).toEqual([]);
  });

  it("refuses to write over notes that are gone", async () => {
    const { notes } = await setup();
    await expect(notes.write(owner("Sam Duarte"), ["x"], "3")).rejects.toThrow(PortError);
  });
});
