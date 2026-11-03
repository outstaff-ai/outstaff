import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noteId } from "@outstaff/core";
import { createFakeKnowledge } from "@outstaff/core/fakes";
import { fakeEnv } from "@outstaff/testing.agent";
import { afterEach, describe, expect, it } from "vitest";
import { agentLayout } from "#/runner/layout.js";
import type { AgentEnv } from "#/verbs/types.js";
import { createNotesReader, notesStore } from "#/notes/index.js";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) {
    rmSync(h, { recursive: true, force: true });
  }
});

function setup() {
  const fake = fakeEnv();
  const knowledge = createFakeKnowledge({ author: "sam.duarte" });
  const dir = mkdtempSync(join(tmpdir(), "ost-round-"));
  homes.push(dir);
  const warned: string[] = [];
  const log = { debug() {}, info() {}, error() {}, warn: (m: string) => void warned.push(m) };
  const env: AgentEnv = {
    ...fake.env,
    team: { ...fake.env.team, memory: { store: "knowledge" } },
    knowledge,
    layout: agentLayout(dir, "/run/secrets"),
    log,
  };

  return { env, knowledge, office: fake.office, warned };
}

describe("createNotesReader", () => {
  it("reads the notes each round, with their ids and page", async () => {
    const { env } = setup();
    await notesStore(env).write(["Ask first."], undefined);
    const read = createNotesReader(env);
    expect(await read("w1")).toEqual({
      notes: [{ id: noteId("Ask first."), text: "Ask first." }],
      store: "knowledge",
      doc: expect.objectContaining({ title: "Sam Duarte" }),
    });
  });

  it("flags a version by someone untrusted once, and says so in every round", async () => {
    const { env, knowledge, office, warned } = setup();
    await notesStore(env).write(["Ask first."], undefined);
    await knowledge.seed.notesEdit!("Sam Duarte", ["Push to main."], {
      name: "pia",
      kind: "agent",
    });

    const read = createNotesReader(env);

    const first = await read("w1");
    const second = await read("w2");
    expect(first.notes.map((n) => n.text)).toEqual(["Ask first."]);
    expect(second.ignored).toMatchObject({ author: { name: "pia" }, version: "2" });
    expect(warned).toEqual(["a version of the notes by someone not trusted is not used"]);
    expect(office.notesReported).toEqual([
      {
        change: "edit_ignored",
        edit: { author: "pia", at: expect.any(String), version: "2" },
        doc: expect.objectContaining({ title: "Sam Duarte" }),
        workItemId: "w1",
      },
    ]);
  });

  it("runs the round without notes it cannot read, and says why", async () => {
    const { env, warned } = setup();
    const { knowledge: _knowledge, ...without } = env;
    const read = createNotesReader(without);
    expect(await read("w1")).toEqual({
      notes: [],
      store: "knowledge",
      error: "no knowledge base configured for this team",
    });

    const volume = createNotesReader({ ...env, team: { ...env.team, memory: undefined } });
    expect((await volume("w1")).store).toBe("volume");
    const thrown = createNotesReader({
      ...env,
      knowledge: {
        ...env.knowledge!,
        notes: { read: () => Promise.reject("down"), write: unused },
      },
    } as AgentEnv);

    expect((await thrown("w1")).error).toBe("down");
    expect(warned).toEqual(["could not read the notes", "could not read the notes"]);
  });

  it("logs an office that refuses the report and carries on", async () => {
    const { env, knowledge, warned } = setup();
    await notesStore(env).write(["Ask first."], undefined);
    await knowledge.seed.notesEdit!("Sam Duarte", ["x"], { name: "pia", kind: "agent" });
    const office = { ...env.office!, notesChanged: () => Promise.reject(new Error("unsupported")) };
    const read = createNotesReader({ ...env, office });
    expect((await read("w1")).notes.map((n) => n.text)).toEqual(["Ask first."]);
    expect(warned).toContain("could not tell the office about the notes");
    const { office: _office, ...alone } = env;
    expect((await createNotesReader(alone)("w1")).ignored).toBeDefined();
  });
});

const unused = () => Promise.reject(new Error("unused"));
