import { PortError } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { findVerb, runVerb } from "#/verbs/index.js";
import { fakeEnv } from "@outstaff/testing.agent";

type Fake = ReturnType<typeof fakeEnv>;

const run = (name: string, f: Fake, input: Record<string, unknown>, ctx = {}) =>
  runVerb(findVerb(name)!, f.env, input, ctx);

const failure = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as PortError,
  );

/** Three tickets: SHOP-1, SHOP-2 and SHOP-3. */
async function three(): Promise<Fake> {
  const f = fakeEnv();
  for (const title of ["Pick the font", "Set the font", "Font size"]) {
    await f.tracker.createIssue({ title, body: "" });
  }

  return f;
}

describe("ticket.link", () => {
  it("links a ticket as blocked by, blocking, or related to another, as the tracker states it", async () => {
    const f = await three();
    const r = await run("ticket.link", f, { key: "SHOP-2", blockedBy: "SHOP-1" });
    await run("ticket.link", f, { key: "SHOP-2", blocks: "SHOP-3" });
    await run("ticket.link", f, { key: "SHOP-3", relates: "SHOP-1" });

    expect(r.text).toContain("Linked: SHOP-1 blocks SHOP-2.");
    expect(r.links).toEqual([f.tracker.links.issue("SHOP-2")]);
    expect(f.tracker.relations).toEqual([
      { key: "SHOP-1", otherKey: "SHOP-2", relation: "blocks" },
      { key: "SHOP-2", otherKey: "SHOP-3", relation: "blocks" },
      { key: "SHOP-3", otherKey: "SHOP-1", relation: "relates" },
    ]);

    expect((await f.tracker.getIssue("SHOP-2")).blockedBy?.map((l) => l.key)).toEqual(["SHOP-1"]);
  });

  it("removes a link, and removing one that is not there changes nothing", async () => {
    const f = await three();
    await run("ticket.link", f, { key: "SHOP-2", blockedBy: "SHOP-1" });
    await run("ticket.link", f, { key: "SHOP-3", relates: "SHOP-1" });
    const r = await run("ticket.link", f, { key: "SHOP-2", blockedBy: "SHOP-1", remove: true });
    await run("ticket.link", f, { key: "SHOP-1", relates: "SHOP-3", remove: true });
    await run("ticket.link", f, { key: "SHOP-2", blocks: "SHOP-1", remove: true });

    expect(r.text).toContain("Removed the link: SHOP-1 blocks SHOP-2.");
    expect(f.tracker.relations).toEqual([]);
  });

  it("takes exactly one other ticket, never the ticket itself, and an existing one", async () => {
    const f = await three();
    for (const input of [
      { key: "SHOP-2" },
      { key: "SHOP-2", blockedBy: "SHOP-1", relates: "SHOP-3" },
      { key: "SHOP-2", blocks: "shop-2" },
    ]) {
      expect((await failure(run("ticket.link", f, input)))?.code).toBe("invalid");
    }

    expect((await failure(run("ticket.link", f, { key: "SHOP-2", blocks: "SHOP-9" })))?.code).toBe(
      "not_found",
    );

    expect(f.tracker.relations).toEqual([]);
  });
});

describe("ticket.create --blocked-by", () => {
  it("files a sub-ticket to be worked as blocked, linked to its open blockers, with nothing in its description", async () => {
    const f = await three();
    await f.tracker.seed.member({ name: "sam", kind: "agent" });
    await f.tracker.transition("SHOP-3", "done");
    const r = await run(
      "ticket.create",
      f,
      {
        title: "Search the index",
        body: "The search half.",
        parent: "SHOP-1",
        blockedBy: ["SHOP-2", "SHOP-3", "SHOP-2"],
        assignee: "me",
        status: "ready",
      },
      { workItemId: "w1" },
    );

    const issue = await f.tracker.getIssue("SHOP-4");
    expect(issue).toMatchObject({ body: "The search half.", status: { canonical: "blocked" } });
    expect(issue.blockedBy?.map((l) => l.key)).toEqual(["SHOP-2", "SHOP-3"]);
    expect(f.tracker.parents.get("SHOP-4")).toBe("SHOP-1");
    expect(r.text).toContain(
      "Blocked by SHOP-2, SHOP-3. It starts blocked and moves to ready when its last blocker closes.",
    );
  });

  it("starts where asked when every blocker is closed, and leaves a backlog ticket in the backlog", async () => {
    const f = await three();
    await f.tracker.transition("SHOP-1", "canceled");
    await run("ticket.create", f, { title: "Later", blockedBy: ["SHOP-1"], status: "active" });
    await run("ticket.create", f, { title: "Someday", blockedBy: ["SHOP-2"] });

    expect((await f.tracker.getIssue("SHOP-4")).status.canonical).toBe("active");
    expect((await f.tracker.getIssue("SHOP-5")).status.canonical).toBe("backlog");
    expect(f.tracker.relations).toEqual([
      { key: "SHOP-1", otherKey: "SHOP-4", relation: "blocks" },
      { key: "SHOP-2", otherKey: "SHOP-5", relation: "blocks" },
    ]);
  });

  it("refuses an unknown blocker before creating anything, and reports a link the tracker refused", async () => {
    const f = await three();
    const unknown = run("ticket.create", f, { title: "Orphan", blockedBy: ["SHOP-9"] });
    expect((await failure(unknown))?.code).toBe("not_found");
    expect(await f.tracker.listIssues({})).toHaveLength(3);

    f.tracker.link = async () => {
      throw new PortError("forbidden", "No links here.");
    };

    const r = await run("ticket.create", f, { title: "Kept", blockedBy: ["SHOP-1"] });
    expect(r.text).toContain("Created SHOP-4.");
    expect(r.text).toContain(
      "Could not link SHOP-1 (No links here.) as blocking SHOP-4: link it with ost ticket link SHOP-4 --blocked-by <key>.",
    );
  });
});
