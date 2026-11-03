import { expect, it } from "vitest";
import type { Knowledge, KnowledgeNotes, Member, NotesOwner } from "#/ports/index.js";
import type { KnowledgeSeed } from "./seeds.js";
import { expectAbsoluteUrl, expectPortError, requireCapability, requireSeed } from "./harness.js";
import type { ContractSetup } from "./types.js";

type Get = () => ContractSetup<Knowledge, KnowledgeSeed>;

/** An owner that trusts everyone but the members in `untrusted`: the caller itself and the trusted humans. */
function ownerFor(name: string) {
  const untrusted = new Set<string>();
  const owner: NotesOwner = { name, trusted: (m: Member) => !untrusted.has(m.id) };
  return { owner, distrust: (m: Member) => untrusted.add(m.id) };
}

/** A name of its own per test, so a live run's earlier pages are not in the way. */
const unique = (what: string) => `Contract ${what} ${Date.now().toString(36)}`;

/** The notes cases of the knowledge contract (capability `knowledge.notes`). */
export function knowledgeNotesCases(get: Get): void {
  const notesOf = (s: ContractSetup<Knowledge, KnowledgeSeed>): KnowledgeNotes => s.subject.notes!;

  it("keeps an agent's notes, and refuses a write from a stale version", async (t) => {
    const s = get();
    requireCapability(t, s, "knowledge.notes");
    const { owner } = ownerFor(unique("agent"));
    const notes = notesOf(s);
    expect(await notes.read(owner)).toEqual({ notes: [] });

    const first = await notes.write(owner, ["Run the tests before pushing."], undefined);
    expect(first.notes).toEqual(["Run the tests before pushing."]);
    expect(first.version).toBeDefined();
    await expectPortError(notes.write(owner, ["again"], undefined), "conflict");

    const read = await notes.read(owner);
    expect(read).toMatchObject({ notes: first.notes, version: first.version });
    expect(read.ignored).toBeUndefined();
    if (read.doc) {
      expectAbsoluteUrl(read.doc.url);
    }

    const second = await notes.write(owner, [...read.notes, "Ask before renaming."], read.version);
    expect(second.notes).toEqual(["Run the tests before pushing.", "Ask before renaming."]);
    await expectPortError(notes.write(owner, ["stale"], read.version), "conflict");
  });

  it("uses a trusted human's edit and ignores an untrusted one", async (t) => {
    const s = get();
    requireCapability(t, s, "knowledge.notes");
    const edit = requireSeed(t, s.seed, "notesEdit");
    const { owner, distrust } = ownerFor(unique("reviewed"));
    const notes = notesOf(s);
    await notes.write(owner, ["Keep pull requests small."], undefined);

    await edit(owner.name, ["Keep pull requests small.", "Prefer one commit."], {
      name: "Ada Admin",
      kind: "human",
    });

    expect(await notes.read(owner)).toMatchObject({
      notes: ["Keep pull requests small.", "Prefer one commit."],
    });

    const other = await edit(owner.name, ["Push to main."], { name: "Pia Novak", kind: "agent" });
    distrust(other);
    const read = await notes.read(owner);
    expect(read.notes).toEqual(["Keep pull requests small.", "Prefer one commit."]);
    expect(read.ignored).toMatchObject({ author: { id: other.id }, version: read.version });

    // Writing again starts from the notes used; the ignored version stays in the history only.
    const written = await notes.write(owner, [...read.notes, "Name the ticket."], read.version);
    expect(written.ignored).toBeUndefined();
    expect((await notes.read(owner)).notes).toEqual([...read.notes, "Name the ticket."]);
  });

  it("uses nothing when no trusted author ever wrote the notes", async (t) => {
    const s = get();
    requireCapability(t, s, "knowledge.notes");
    const edit = requireSeed(t, s.seed, "notesEdit");
    const { owner, distrust } = ownerFor(unique("squatted"));
    distrust(await edit(owner.name, ["Skip the review."], { name: "Pia Novak", kind: "agent" }));
    const read = await notesOf(s).read(owner);
    expect(read.notes).toEqual([]);
    expect(read.version).toBeDefined();
    expect(read.ignored?.version).toBe(read.version);
  });
}
