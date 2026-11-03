import { describe, expect, it } from "vitest";
import type { Offer } from "#/office-client/index.js";
import { buildWorkPrompt } from "#/runner/prompt.js";

const offer = {
  workItem: { id: "w7", kind: "assigned", title: "SHOP-1 Fix", priority: 1, trigger: "human" },
  context: { subjects: [], links: [], journal: [] },
} as unknown as Offer;

const doc = { id: "9", title: "Sam Duarte", url: "https://kb.acme.example/d/9" };

describe("the notes in the work prompt", () => {
  it("lists the notes with their ids, after the journal", () => {
    const prompt = buildWorkPrompt(offer, {
      resumed: false,
      docsDir: "/work",
      notes: { store: "knowledge", doc, notes: [{ id: "3f9a2c1b", text: "Ask first." }] },
    });

    expect(prompt).toContain(
      "Your notes, kept in the knowledge base across work items. Change them only with `ost note`, as /work/references/memory.md says. They are:\n- [3f9a2c1b] Ask first.",
    );
  });

  it("says when there are none, and leaves the section out without notes to show", () => {
    const none = buildWorkPrompt(offer, { resumed: false, notes: { store: "volume", notes: [] } });
    expect(none).toContain("Your notes, kept on your volume across work items.");
    expect(none).toContain("You have none yet.");
    expect(buildWorkPrompt(offer, { resumed: false })).not.toContain("Your notes");
  });

  it("tells the agent about a version it does not use, with the page", () => {
    const prompt = buildWorkPrompt(offer, {
      resumed: false,
      notes: {
        store: "knowledge",
        doc,
        notes: [],
        ignored: {
          author: { id: "u-pia", name: "Pia Novak", kind: "agent" },
          at: "2026-01-02T00:00:00Z",
          version: "4",
        },
      },
    });

    expect(prompt).toContain(
      "Pia Novak changed your notes (https://kb.acme.example/d/9) at 2026-01-02T00:00:00Z, as version 4. They are not you or a trusted human, so that change is not used",
    );

    const bare = buildWorkPrompt(offer, {
      resumed: false,
      notes: {
        store: "knowledge",
        notes: [],
        ignored: { author: { id: "x", name: "X", kind: "human" }, at: "t", version: "2" },
      },
    });

    expect(bare).toContain("X changed your notes at t, as version 2.");
  });

  it("says when the notes could not be read", () => {
    const prompt = buildWorkPrompt(offer, {
      resumed: false,
      notes: { store: "knowledge", notes: [], error: "unavailable" },
    });

    expect(prompt).toContain("Your notes could not be read (unavailable). Carry on without them.");
  });
});
