import { createFakeTracker, createFakeVcs } from "@outstaff/core/fakes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import { teamConfig } from "#/intake/__tests__/test-support.js";
import { officeNotes } from "#/office-notes.js";
import { openStore } from "#/store/open.js";
import type { Store } from "#/store/types.js";
import { createWorkState } from "#/workstate/workstate.js";
import type { WorkState } from "#/workstate/types.js";

const doc = { id: "77", title: "Sam Duarte", url: "https://docs.acme.example/77" };

describe("the office's notes desk", () => {
  let store: Store;
  let ws: WorkState;
  const lines: [string, string, unknown][] = [];
  const log = {
    debug() {},
    error() {},
    info: (m: string, f?: unknown) => void lines.push(["info", m, f]),
    warn: (m: string, f?: unknown) => void lines.push(["warn", m, f]),
  };

  beforeEach(async () => {
    lines.length = 0;
    const clock = manualClock();
    store = await openStore("sqlite::memory:", { now: () => clock.now() });
    ws = await createWorkState({
      store,
      ports: { vcs: createFakeVcs({ now: clock.now }), tracker: createFakeTracker() },
      team: teamConfig(),
      clock,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
  });

  afterEach(async () => {
    await ws.stop();
    await store.close();
  });

  it("logs each change and records the notes page as the agent's document", async () => {
    const notes = officeNotes({ workState: ws, log });
    await notes.changed("sam", { change: "added", note: "Ask first.", doc, workItemId: "w1" });
    await notes.changed("sam", { change: "migrated", count: 3 });

    expect(ws.doc("77")).toMatchObject({ author: "sam", title: "Sam Duarte" });
    expect(lines).toEqual([
      [
        "info",
        "notes of sam: added",
        {
          person: "sam",
          change: "added",
          note: "Ask first.",
          doc: "77",
          url: doc.url,
          workItemId: "w1",
        },
      ],
      ["info", "notes of sam: migrated", { person: "sam", change: "migrated", count: 3 }],
    ]);
  });

  it("warns about a version the agent does not use, naming its author", async () => {
    const notes = officeNotes({ workState: ws, log });
    const edit = { author: "Pia Novak", at: "2026-01-02T00:00:00Z", version: "4" };
    await notes.changed("sam", { change: "edit_ignored", edit, doc });
    expect(lines).toEqual([
      [
        "warn",
        "notes of sam: version 4 by Pia Novak is not used, as Pia Novak is not trusted",
        {
          person: "sam",
          change: "edit_ignored",
          doc: "77",
          url: doc.url,
          author: "Pia Novak",
          at: edit.at,
          version: "4",
        },
      ],
    ]);
  });
});
