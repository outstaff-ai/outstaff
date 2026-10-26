import { describe, expect, it } from "vitest";
import { createFakeKnowledge, createFakeTracker } from "../../fakes/index.js";
import { applyActOps } from "../apply.js";
import { trackerMemberOf } from "../members.js";

const SAM = { id: "u-sam", name: "Sam Duarte", kind: "agent" as const };

describe("applyActOps", () => {
  it("moves, assigns, comments and sets a parent as the identity of the ports given, in order", async () => {
    const tracker = createFakeTracker({ actor: { id: "u-office", name: "Office", kind: "agent" } });
    const parent = await tracker.createIssue({ title: "Search", body: "", status: "active" });
    const child = await tracker.createIssue({ title: "Search API", body: "", status: "active" });
    const ada = await tracker.seed.member({ name: "Ada Admin" });
    const knowledge = createFakeKnowledge();
    const doc = await knowledge.create({
      path: "design/search",
      title: "Search design",
      body: "x",
    });

    const asSam = tracker.as(SAM);
    const outcome = await applyActOps(
      [
        { op: "move", ticket: child.key, to: "review" },
        { op: "assign", ticket: child.key, to: { kind: "human", id: "ada.admin" } },
        { op: "assign", ticket: parent.key, to: null },
        { op: "comment", on: { ticket: child.key }, body: "Ready for review." },
        { op: "comment", on: { doc: doc.id }, body: "Updated." },
        { op: "set_parent", ticket: child.key, parent: parent.key },
      ],
      { tracker: asSam, knowledge },
      async () => ada.id,
    );

    expect(outcome).toEqual({
      ok: true,
      results: [
        `moved ${child.key} to review`,
        `assigned ${child.key} to ada.admin`,
        `unassigned ${parent.key}`,
        `commented on ${child.key}`,
        `commented on doc ${doc.id}`,
        `set the parent of ${child.key} to ${parent.key}`,
      ],
    });

    expect((await tracker.getIssue(child.key)).status.canonical).toBe("review");
    expect(tracker.parents.get(child.key)).toBe(parent.key);
    const moved = (await tracker.events()).events.find((e) => e.type === "moved");
    expect(moved?.actor).toEqual(SAM);
  });

  it("stops at the first change that fails and says which", async () => {
    const tracker = createFakeTracker();
    const issue = await tracker.createIssue({ title: "t", body: "", status: "ready" });
    expect(
      await applyActOps(
        [
          { op: "move", ticket: issue.key, to: "active" },
          { op: "move", ticket: "ACME-404", to: "done" },
          { op: "move", ticket: issue.key, to: "done" },
        ],
        { tracker },
        async (t) => t.id,
      ),
    ).toEqual({
      ok: false,
      results: [`moved ${issue.key} to active`],
      error: "move ACME-404: Issue ACME-404 not found.",
    });
  });

  it("needs the port each change uses", async () => {
    const member = async () => "m";
    expect(await applyActOps([{ op: "move", ticket: "ACME-1", to: "done" }], {}, member)).toEqual({
      ok: false,
      results: [],
      error: "move ACME-1: no tracker is configured",
    });

    expect(
      await applyActOps([{ op: "comment", on: { doc: "d" }, body: "x" }], {}, member),
    ).toMatchObject({
      error: "comment: no knowledge base is configured",
    });

    const { setParent: _setParent, ...noParents } = createFakeTracker();
    expect(
      await applyActOps(
        [{ op: "set_parent", ticket: "ACME-2", parent: "ACME-1" }],
        { tracker: noParents },
        member,
      ),
    ).toMatchObject({
      error: "set_parent ACME-2: the tracker has no parent field (tracker.parents)",
    });
  });
});

describe("trackerMemberOf", () => {
  const team = {
    people: [{ handle: "sam", identities: { tracker: "sam.duarte" } }, { handle: "noor" }],
  } as never;

  it("gives an agent's tracker identity, else its handle", async () => {
    const tracker = createFakeTracker();
    expect(await trackerMemberOf({ kind: "agent", id: "sam" }, team, tracker)).toBe("sam.duarte");
    expect(await trackerMemberOf({ kind: "agent", id: "noor" }, team, tracker)).toBe("noor");
  });

  it("finds a human's member by id, username or name, else keeps the identity", async () => {
    const tracker = createFakeTracker();
    const ada = await tracker.seed.member({ name: "Ada Admin" });
    expect(await trackerMemberOf({ kind: "human", id: ada.id }, team, tracker)).toBe(ada.id);
    expect(await trackerMemberOf({ kind: "human", id: "ada admin" }, team, tracker)).toBe(ada.id);
    expect(await trackerMemberOf({ kind: "human", id: "grace.lead" }, team, tracker)).toBe(
      "grace.lead",
    );
  });
});
