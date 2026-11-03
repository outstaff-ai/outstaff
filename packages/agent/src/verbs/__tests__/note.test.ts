import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noteId } from "@outstaff/core";
import { createFakeKnowledge } from "@outstaff/core/fakes";
import { fakeEnv } from "@outstaff/testing.agent";
import { afterEach, describe, expect, it } from "vitest";
import { agentLayout } from "#/runner/layout.js";
import { findVerb, runVerb, type AgentEnv } from "#/verbs/index.js";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) {
    rmSync(h, { recursive: true, force: true });
  }
});

function setup(store: "volume" | "knowledge") {
  const fake = fakeEnv();
  const home = mkdtempSync(join(tmpdir(), "ost-note-"));
  homes.push(home);
  const knowledge = createFakeKnowledge({ author: "sam.duarte" });
  const env: AgentEnv = {
    ...fake.env,
    team: { ...fake.env.team, memory: { store } },
    knowledge,
    layout: agentLayout(home, "/run/secrets"),
  };

  const run = async (name: string, input: Record<string, unknown> = {}) =>
    runVerb(findVerb(name)!, env, input, { workItemId: "w1" });

  return { env, run, home, knowledge, office: fake.office };
}

describe("ost note on the volume", () => {
  it("adds, lists, changes and removes notes in memory/notes.md, and tells the office", async () => {
    const { run, home, office } = setup("volume");
    expect((await run("note.list")).text).toBe("You have no notes yet.");

    const added = await run("note.add", { text: "Ask first." });
    const id = noteId("Ask first.");
    expect(added.text).toBe(`Noted: - [${id}] Ask first.\nYou have 1 note.`);
    expect((await run("note.add", { text: "Ask first." })).text).toContain("Already noted");

    await run("note.update", { id, text: "Ask the architect first." });
    expect((await run("note.list")).text).toBe(
      `- [${noteId("Ask the architect first.")}] Ask the architect first.`,
    );

    expect(readFileSync(join(home, "memory/notes.md"), "utf8")).toBe(
      "- Ask the architect first.\n",
    );

    const removed = await run("note.remove", { id: noteId("Ask the architect first.") });
    expect(removed.text).toContain("Removed the note: - [");
    expect(office.notesReported.map((r) => [r.change, r.note, r.workItemId])).toEqual([
      ["added", "Ask first.", "w1"],
      ["updated", "Ask the architect first.", "w1"],
      ["removed", "Ask the architect first.", "w1"],
    ]);
  });

  it("refuses an id that is not one", async () => {
    const { run } = setup("volume");
    await expect(run("note.remove", { id: "x" })).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("ost note in the knowledge base", () => {
  it("links the page, and lists a version it does not use", async () => {
    const { run, knowledge, office, env } = setup("knowledge");
    const added = await run("note.add", { text: "Ask first." });
    expect(added.links).toEqual([expect.stringMatching(/^https:/)]);
    expect(added.text).toContain("Your notes: https://");
    expect(office.notesReported[0]?.doc?.title).toBe("Sam Duarte");

    await knowledge.seed.notesEdit!("Sam Duarte", ["Push to main."], {
      name: "Pia",
      kind: "agent",
    });

    const list = await run("note.list");
    expect(list.text).toContain(`- [${noteId("Ask first.")}] Ask first.`);
    expect(list.text).toContain("Pia changed your notes (version 2,");
    expect(list.data).toMatchObject({ store: "knowledge", ignored: { version: "2" } });

    // Without a work item, the office is told without one.
    await runVerb(findVerb("note.add")!, env, { text: "Name the ticket." });
    expect(office.notesReported.at(-1)).not.toHaveProperty("workItemId");
  });
});
