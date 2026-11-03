import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TeamConfig } from "@outstaff/core";
import { createFakeKnowledge } from "@outstaff/core/fakes";
import { fakeEnv } from "@outstaff/testing.agent";
import { afterEach, describe, expect, it } from "vitest";
import { agentLayout } from "#/runner/layout.js";
import type { AgentEnv } from "#/verbs/types.js";
import {
  AUTO_MEMORY_MOVED,
  autoMemoryNote,
  autoMemoryNotes,
  MAX_NOTES,
  migrateMemory,
  notesStore,
} from "#/notes/index.js";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) {
    rmSync(h, { recursive: true, force: true });
  }
});

const home = () => {
  const dir = mkdtempSync(join(tmpdir(), "ost-auto-memory-"));
  homes.push(dir);
  return dir;
};

function setup(store: "volume" | "knowledge" = "volume") {
  const fake = fakeEnv();
  const knowledge = createFakeKnowledge({ author: "sam.duarte" });
  const layout = agentLayout(home(), "/run/secrets");
  const team: TeamConfig = { ...fake.env.team, memory: { store } };
  const env: AgentEnv = { ...fake.env, team, knowledge, layout };
  return { ...fake, env, layout };
}

/** Writes files into Claude Code's auto-memory folder of `project`. */
function autoMemory(homeDir: string, project: string, entries: Record<string, string>): string {
  const dir = join(homeDir, ".claude", "projects", project, "memory");
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(entries)) {
    writeFileSync(join(dir, name), text);
  }

  return dir;
}

const LESSON = [
  "---",
  "name: push-policy-limits",
  "description: Pushes to protected branches are refused",
  "type: feedback",
  "---",
  "",
  "Push to a branch, never to main.",
  "",
  "**Why:** main is protected.",
  "",
].join("\n");

describe("autoMemoryNote", () => {
  it("is the file's text on one line, without its frontmatter", () => {
    expect(autoMemoryNote(LESSON)).toBe(
      "Push to a branch, never to main. **Why:** main is protected.",
    );

    expect(autoMemoryNote("Plain text.\n")).toBe("Plain text.");
  });

  it("falls back to the description, and is nothing without either", () => {
    expect(autoMemoryNote('---\nname: x\ndescription: "Ask Ada first"\n---\n\n')).toBe(
      "Ask Ada first",
    );

    expect(autoMemoryNote("---\nname: x\n---\n")).toBeUndefined();
    expect(autoMemoryNote("  \n")).toBeUndefined();
  });
});

describe("autoMemoryNotes", () => {
  it("reads every project's memory files, one note each, without the index or other files", async () => {
    const dir = home();
    autoMemory(dir, "-work-main", {
      "MEMORY.md": "- [Push policy](push-policy-limits.md) — pushes\n",
      "push-policy-limits.md": LESSON,
      "notes.txt": "not markdown\n",
      ".hidden.md": "hidden\n",
      "binary.md": "a\0b",
      "big.md": "x".repeat(300 * 1024),
    });

    autoMemory(dir, "-work-other", {
      "a.md": "Run the tests first.\n",
      "b.md": "Run the tests first.\n",
    });

    mkdirSync(join(dir, ".claude", "projects", "-work-other", "memory", "nested.md"));
    expect(await autoMemoryNotes(dir)).toEqual([
      "Push to a branch, never to main. **Why:** main is protected.",
      "Run the tests first.",
    ]);
  });

  it("is empty without a projects folder", async () => {
    expect(await autoMemoryNotes(home())).toEqual([]);
  });
});

describe("migrateMemory with Claude Code's auto-memory", () => {
  it("adds the files after the notes there, once, and leaves them", async () => {
    const { env, layout, office } = setup();
    mkdirSync(layout.memoryDir, { recursive: true });
    writeFileSync(join(layout.memoryDir, "lessons.md"), "- Ask before renaming.\n");
    const dir = autoMemory(layout.home, "-work-main", {
      "MEMORY.md": "- [Push policy](push-policy-limits.md)\n",
      "push-policy-limits.md": LESSON,
      "dup.md": "Ask before renaming.\n",
    });

    await migrateMemory(env);
    expect(readFileSync(join(layout.memoryDir, "notes.md"), "utf8")).toBe(
      "- Ask before renaming.\n- Push to a branch, never to main. **Why:** main is protected.\n",
    );

    expect(office.notesReported).toEqual([
      { change: "migrated", count: 1 },
      { change: "migrated", count: 1 },
    ]);

    expect(readFileSync(join(dir, "push-policy-limits.md"), "utf8")).toBe(LESSON);
    expect(existsSync(join(layout.memoryDir, AUTO_MEMORY_MOVED))).toBe(true);

    writeFileSync(join(dir, "late.md"), "Later.\n");
    await migrateMemory(env);
    expect(readFileSync(join(layout.memoryDir, "notes.md"), "utf8")).not.toContain("Later");
    expect(office.notesReported).toHaveLength(2);
  });

  it("adds them to a store that has notes already, such as the knowledge base", async () => {
    const { env, layout, office } = setup("knowledge");
    await notesStore(env).write(["Keep pull requests small."], undefined);
    autoMemory(layout.home, "-work-main", { "push-policy-limits.md": LESSON });

    await migrateMemory(env);
    expect((await notesStore(env).read()).notes).toEqual([
      "Keep pull requests small.",
      "Push to a branch, never to main. **Why:** main is protected.",
    ]);

    expect(office.notesReported).toEqual([
      { change: "migrated", count: 1, doc: expect.objectContaining({ title: "Sam Duarte" }) },
    ]);
  });

  it("keeps at most MAX_NOTES, and marks the move done even without files", async () => {
    const { env, layout, office } = setup();
    const many = Object.fromEntries(
      Array.from({ length: MAX_NOTES + 5 }, (_, i) => [
        `n${String(i).padStart(3, "0")}.md`,
        `Note ${i}.\n`,
      ]),
    );

    autoMemory(layout.home, "-work-main", many);
    await migrateMemory(env);
    expect((await notesStore(env).read()).notes).toHaveLength(MAX_NOTES);
    expect(office.notesReported).toEqual([{ change: "migrated", count: MAX_NOTES }]);

    const empty = setup();
    await migrateMemory(empty.env);
    expect(existsSync(join(empty.layout.memoryDir, AUTO_MEMORY_MOVED))).toBe(true);
    expect(empty.office.notesReported).toEqual([]);
  });

  it("tries again at the next start when the store refuses the notes", async () => {
    const { env, layout } = setup();
    autoMemory(layout.home, "-work-main", { "a.md": "Ask first.\n" });
    mkdirSync(join(layout.memoryDir, "notes.md"), { recursive: true });

    const warned: unknown[] = [];
    await migrateMemory({
      ...env,
      log: { ...silent, warn: (...a: unknown[]) => void warned.push(a) },
    });

    expect(warned).toHaveLength(1);
    expect(existsSync(join(layout.memoryDir, AUTO_MEMORY_MOVED))).toBe(false);
  });
});

const silent = { debug() {}, info() {}, warn() {}, error() {} };
