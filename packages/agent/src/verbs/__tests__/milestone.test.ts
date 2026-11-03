import type { PortError, Tracker } from "@outstaff/core";
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

describe("ost milestone", () => {
  it("creates milestones, lists them in order, and by status", async () => {
    const f = fakeEnv();
    const made = await run("milestone.create", f, {
      title: "Foundations",
      description: "Goal: the store.",
      status: "active",
    });

    expect(made.text).toContain("Created milestone 1.");
    await run("milestone.create", f, { title: "Monitoring" });
    const all = await run("milestone.list", f, {});
    expect(all.text).toBe(
      [
        "- 1 [active] Foundations: https://tracker.acme.example/initiative/1",
        "- 2 [planned] Monitoring: https://tracker.acme.example/initiative/2",
      ].join("\n"),
    );

    expect((await run("milestone.list", f, { status: ["planned"] })).text).not.toContain(
      "Foundations",
    );

    expect((await run("milestone.list", f, { status: ["done"] })).text).toBe("No milestones.");
  });

  it("puts tickets in a milestone, links its plan, shows both, and closes it", async () => {
    const f = fakeEnv();
    await f.tracker.createInitiative!({ title: "Monitoring" });
    await f.knowledge.seed.initiative!();
    const { key } = await f.tracker.createIssue({ title: "Plan monitoring", body: "" });
    const doc = await f.knowledge.create({
      path: "plans/monitoring",
      title: "Monitoring plan",
      body: "",
    });

    const added = await run("milestone.add", f, { id: "1", ticket: key, doc: doc.id });
    expect(added.text).toContain(`${key} is in milestone 1`);
    expect(added.text).toContain(`Linked ${doc.id} to milestone 1.`);
    expect((await run("milestone.add", f, { id: "1", doc: doc.id })).text).toContain(
      "was linked already",
    );

    const shown = await run("milestone.show", f, { id: "1" });
    expect(shown.text).toContain("1: Monitoring [planned]");
    expect(shown.text).toContain("(no description)");
    expect(shown.text).toContain(`- ${key} [backlog] Plan monitoring: `);
    expect(shown.text).toContain(`- Monitoring plan: ${f.knowledge.links.doc(doc.id)}`);

    const closed = await run("milestone.status", f, { id: "1", to: "done" });
    expect(closed.text).toContain("Milestone 1 is done.");
    expect(f.tracker.initiativeList.get("1")?.status).toBe("done");
  });

  it("files a ticket of a milestone, which is no sub-ticket of the current work's ticket", async () => {
    const f = fakeEnv();
    await f.tracker.createIssue({ title: "Fix checkout", body: "" });
    await f.tracker.createInitiative!({ title: "Monitoring", status: "active" });
    const r = await run(
      "ticket.create",
      f,
      { title: "Collect resource metrics", milestone: "1" },
      { workItemId: "w1" },
    );

    const key = (r.data as { issue: { key: string } }).issue.key;
    expect(f.tracker.ticketInitiatives.get(key)).toBe("1");
    expect(f.tracker.parents.get(key)).toBeUndefined();
    const unknown = await failure(
      run("ticket.create", f, { title: "Elsewhere", milestone: "9" }, { workItemId: "w1" }),
    );

    expect(unknown?.code).toBe("not_found");
    expect((await f.tracker.listIssues({})).map((i) => i.title)).not.toContain("Elsewhere");
  });

  it("refuses on a tracker without initiatives, naming the parent-ticket fallback, and without input", async () => {
    const f = fakeEnv();
    const { initiatives: _i, setInitiative: _s, ...plain } = f.tracker;
    f.env.tracker = plain as Tracker;
    const e = await failure(run("milestone.list", f, {}));
    expect(e?.code).toBe("unsupported");
    expect(e?.message).toContain("keep each milestone as a parent ticket");

    const g = fakeEnv();
    await g.tracker.createInitiative!({ title: "Monitoring" });
    expect((await failure(run("milestone.add", g, { id: "1" })))?.code).toBe("invalid");
    const { linkInitiative: _l, ...noLinks } = g.knowledge;
    g.env.knowledge = noLinks;
    expect((await failure(run("milestone.add", g, { id: "1", doc: "x" })))?.code).toBe(
      "unsupported",
    );

    delete g.env.knowledge;
    expect((await run("milestone.show", g, { id: "1" })).text).not.toContain("Documents:");
  });
});
