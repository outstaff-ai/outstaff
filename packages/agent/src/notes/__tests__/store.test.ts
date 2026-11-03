import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PortError, noteId, type TeamConfig } from "@outstaff/core";
import { createFakeKnowledge } from "@outstaff/core/fakes";
import { fakeEnv } from "@outstaff/testing.agent";
import { afterEach, describe, expect, it } from "vitest";
import { agentLayout } from "#/runner/layout.js";
import type { AgentEnv } from "#/verbs/types.js";
import {
  addNote,
  MAX_NOTES,
  migrateMemory,
  notesStore,
  removeNote,
  updateNote,
  volumeNotes,
  type NotesStore,
} from "#/notes/index.js";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) {
    rmSync(h, { recursive: true, force: true });
  }
});

const home = () => {
  const dir = mkdtempSync(join(tmpdir(), "ost-notes-"));
  homes.push(dir);
  return dir;
};

const withStore = (team: TeamConfig, store: "volume" | "knowledge"): TeamConfig => ({
  ...team,
  memory: { store },
});

/** The fake env as sam, with a home, keeping notes in `store`; the knowledge base knows sam by tracker identity. */
function setup(store: "volume" | "knowledge" = "volume") {
  const fake = fakeEnv();
  const knowledge = createFakeKnowledge({ author: "sam.duarte" });
  const layout = agentLayout(home(), "/run/secrets");
  const team = withStore(fake.env.team, store);
  const env: AgentEnv = { ...fake.env, team, knowledge, layout };
  return { ...fake, knowledge, env, layout };
}

describe("the volume store", () => {
  it("keeps the notes as a list in memory/notes.md, versioned by its text", async () => {
    const dir = join(home(), "memory");
    const store = volumeNotes(dir);
    expect(await store.read()).toEqual({ notes: [] });

    const written = await store.write(["One.", "Two."], undefined);
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("- One.\n- Two.\n");
    expect(await store.read()).toEqual(written);
    await expect(store.write(["Three."], undefined)).rejects.toMatchObject({ code: "conflict" });
  });

  it("passes on a file it cannot read", async () => {
    const dir = home();
    mkdirSync(join(dir, "notes.md"));
    await expect(volumeNotes(dir).read()).rejects.toMatchObject({ code: "EISDIR" });
  });
});

describe("notesStore", () => {
  it("is the volume by default, and needs a home there", () => {
    const { env } = setup();
    expect(notesStore({ ...env, team: { ...env.team, memory: undefined } }).kind).toBe("volume");
    const { layout: _layout, ...homeless } = env;
    expect(() => notesStore(homeless)).toThrow(PortError);
  });

  it("is the knowledge base's notes with store: knowledge, refused without them", () => {
    const { env } = setup("knowledge");
    expect(notesStore(env).kind).toBe("knowledge");
    const { notes: _notes, ...plain } = env.knowledge!;
    expect(() => notesStore({ ...env, knowledge: plain })).toThrow(/knowledge.notes/);
    const { knowledge: _knowledge, ...without } = env;
    expect(() => notesStore(without)).toThrow(/knowledge base/);
  });

  it("names the notes after the person, and trusts sam and the team's humans only", async () => {
    const { env, knowledge } = setup("knowledge");
    const store = notesStore(env);
    await store.write(["Mine."], undefined);
    await knowledge.seed.notesEdit!("Sam Duarte", ["Mine.", "Ada's."], {
      name: "ada.admin",
      kind: "human",
    });

    expect((await store.read()).notes).toEqual(["Mine.", "Ada's."]);
    await knowledge.seed.notesEdit!("Sam Duarte", ["Pia's."], { name: "pia", kind: "agent" });
    const read = await store.read();
    expect(read.notes).toEqual(["Mine.", "Ada's."]);
    expect(read.ignored?.author.name).toBe("pia");

    // Without its person in the team, the handle names the notes.
    const stranger = notesStore({ ...env, person: "zed" });
    expect(await stranger.read()).toEqual({ notes: [] });
  });
});

/** A store whose first write loses a race to `meanwhile`. */
function racing(store: NotesStore, meanwhile: string[]): NotesStore {
  let raced = false;
  return {
    ...store,
    async write(notes, version) {
      if (!raced) {
        raced = true;
        await store.write(meanwhile, version);
      }

      return store.write(notes, version);
    },
  };
}

describe("changing notes", () => {
  it("adds a note once, and refuses an empty one or one too many", async () => {
    const store = volumeNotes(home());
    const added = await addNote(store, "  Run the tests\nfirst. ");
    expect(added).toMatchObject({
      change: "added",
      changed: true,
      note: { id: noteId("Run the tests first."), text: "Run the tests first." },
    });

    expect((await addNote(store, "Run the tests first.")).changed).toBe(false);
    await expect(addNote(store, " \n ")).rejects.toMatchObject({ code: "invalid" });

    const full = volumeNotes(home());
    await full.write(
      Array.from({ length: MAX_NOTES }, (_, i) => `Note ${i}.`),
      undefined,
    );

    await expect(addNote(full, "One more.")).rejects.toThrow(/Remove or merge/);
  });

  it("changes and removes a note by id, and refuses an unknown id", async () => {
    const store = volumeNotes(home());
    await store.write(["Ask first.", "Keep it small."], undefined);
    const updated = await updateNote(store, noteId("Ask first."), "Ask the architect first.");
    expect(updated.page.notes).toEqual(["Ask the architect first.", "Keep it small."]);

    const same = await updateNote(store, noteId("Keep it small."), "Keep it small.");
    expect(same.changed).toBe(false);

    // A new text that another note already has merges the two.
    const merged = await updateNote(store, noteId("Keep it small."), "Ask the architect first.");
    expect(merged.page.notes).toEqual(["Ask the architect first."]);

    const removed = await removeNote(store, noteId("Ask the architect first."));
    expect(removed).toMatchObject({
      change: "removed",
      note: { text: "Ask the architect first." },
    });

    expect(removed.page.notes).toEqual([]);
    await expect(removeNote(store, "00000000")).rejects.toMatchObject({ code: "not_found" });
  });

  it("reads again and retries once when a write lost a race", async () => {
    const dir = home();
    const store = volumeNotes(dir);
    await store.write(["A."], undefined);
    const done = await addNote(racing(store, ["A.", "B."]), "C.");
    expect(done.page.notes).toEqual(["A.", "B.", "C."]);

    const always: NotesStore = {
      ...store,
      write: () => Promise.reject(new PortError("conflict", "again")),
    };

    await expect(addNote(always, "D.")).rejects.toMatchObject({ code: "conflict" });
    const broken: NotesStore = { ...store, write: () => Promise.reject(new Error("disk full")) };
    await expect(addNote(broken, "D.")).rejects.toThrow("disk full");
  });
});

describe("migrateMemory", () => {
  const files = (dir: string, entries: Record<string, string>) => {
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(entries)) {
      writeFileSync(join(dir, name), text);
    }
  };

  it("moves the files of memory/ into the volume's notes file once, and leaves them", async () => {
    const { env, layout, office } = setup();
    files(layout.memoryDir, {
      "lessons.md": "# Lessons\n\n- Run the tests first.\n- Ask before renaming.\n",
      "team.md": "Ada wants small pull requests.\n\n- Run the tests first.\n",
      ".hidden": "- not this\n",
      "binary.bin": "a\0b",
      "notes.md.1.tmp": "- not this either\n",
    });

    mkdirSync(join(layout.memoryDir, "old"));
    writeFileSync(join(layout.memoryDir, "big.md"), "x".repeat(300 * 1024));

    await migrateMemory(env);
    expect(readFileSync(join(layout.memoryDir, "notes.md"), "utf8")).toBe(
      "- Run the tests first.\n- Ask before renaming.\n- Ada wants small pull requests.\n",
    );

    expect(office.notesReported).toEqual([{ change: "migrated", count: 3 }]);
    expect(readFileSync(join(layout.memoryDir, "lessons.md"), "utf8")).toContain("Lessons");

    writeFileSync(join(layout.memoryDir, "late.md"), "- Later.\n");
    await migrateMemory(env);
    expect(readFileSync(join(layout.memoryDir, "notes.md"), "utf8")).not.toContain("Later");
  });

  it("writes them to the agent's page in the knowledge base, which it then reports", async () => {
    const { env, layout, office } = setup("knowledge");
    files(layout.memoryDir, { "notes.md": "- Ask first.\n" });
    await migrateMemory(env);
    expect((await notesStore(env).read()).notes).toEqual(["Ask first."]);
    expect(office.notesReported).toEqual([
      {
        change: "migrated",
        count: 1,
        doc: { id: "notes-Sam%20Duarte", title: "Sam Duarte", url: expect.any(String) },
      },
    ]);
  });

  it("does nothing without files, and logs instead of failing", async () => {
    const { env } = setup();
    await migrateMemory(env);
    expect(await notesStore(env).read()).toEqual({ notes: [] });

    const warned: unknown[] = [];
    const log = { ...silent, warn: (...a: unknown[]) => void warned.push(a) };
    const { layout: _layout, ...homeless } = env;
    await migrateMemory({ ...homeless, log });
    expect(warned).toHaveLength(1);
  });
});

const silent = { debug() {}, info() {}, warn() {}, error() {} };
