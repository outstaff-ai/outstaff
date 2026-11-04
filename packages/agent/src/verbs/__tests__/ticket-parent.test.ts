import { PortError } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { findVerb, runVerb } from "#/verbs/index.js";
import { fakeEnv } from "@outstaff/testing.agent";

type Fake = ReturnType<typeof fakeEnv>;

const run = (f: Fake, input: Record<string, unknown>) =>
  runVerb(findVerb("ticket.parent")!, f.env, input, {});

const failure = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as PortError,
  );

/** SHOP-1, a parent, with SHOP-2 and SHOP-3 under it, and SHOP-4 under none. */
async function family(): Promise<Fake> {
  const f = fakeEnv();
  const parent = await f.tracker.createIssue({ title: "Checkout", body: "" });
  for (const title of ["Pay button", "Receipt"]) {
    await f.tracker.createIssue({ title, body: "", parent: parent.key });
  }

  await f.tracker.createIssue({ title: "Loose", body: "" });
  return f;
}

describe("ticket.parent", () => {
  it("sets the parent of a ticket: the ticket, then its parent", async () => {
    const f = await family();
    const r = await run(f, { tickets: ["SHOP-4", "SHOP-1"] });
    expect(f.tracker.parents.get("SHOP-4")).toBe("SHOP-1");
    expect(r.text).toContain("SHOP-4 is now a subtask of SHOP-1.");
    expect(r.links).toEqual([f.tracker.links.issue("SHOP-4")]);
  });

  it("refuses anything but a ticket and its parent without clear", async () => {
    const f = await family();
    for (const tickets of [["SHOP-4"], ["SHOP-4", "SHOP-1", "SHOP-2"]]) {
      expect((await failure(run(f, { tickets })))?.code).toBe("invalid");
    }

    expect(f.tracker.parents.get("SHOP-4")).toBeUndefined();
  });

  it("refuses a tracker without parents", async () => {
    const f = await family();
    delete (f.tracker as { setParent?: unknown }).setParent;
    expect((await failure(run(f, { tickets: ["SHOP-4", "SHOP-1"] })))?.code).toBe("unsupported");
    expect((await failure(run(f, { tickets: ["SHOP-2"], clear: true })))?.code).toBe("unsupported");
  });

  it("clears the parent of one ticket", async () => {
    const f = await family();
    const r = await run(f, { tickets: ["SHOP-2"], clear: true });
    expect(f.tracker.parents.has("SHOP-2")).toBe(false);
    expect(f.tracker.parents.get("SHOP-3")).toBe("SHOP-1");
    expect(r.text).toContain("SHOP-2 is no longer a subtask of SHOP-1.");
    expect(r.data).toEqual({ tickets: [{ key: "SHOP-2", outcome: "cleared", parent: "SHOP-1" }] });
  });

  it("clears several, reporting each, past a ticket without a parent and one that fails", async () => {
    const f = await family();
    const r = await run(f, { tickets: ["SHOP-2", "SHOP-4", "SHOP-99", "SHOP-3"], clear: true });
    expect(f.tracker.parents.size).toBe(0);
    expect(r.text.split("\n").slice(0, 4)).toEqual([
      "SHOP-2 is no longer a subtask of SHOP-1.",
      "SHOP-4 has no parent.",
      expect.stringMatching(/^SHOP-99: /),
      "SHOP-3 is no longer a subtask of SHOP-1.",
    ]);

    expect(r.data).toEqual({
      tickets: [
        { key: "SHOP-2", outcome: "cleared", parent: "SHOP-1" },
        { key: "SHOP-4", outcome: "no_parent" },
        { key: "SHOP-99", outcome: "failed", code: "not_found", message: expect.any(String) },
        { key: "SHOP-3", outcome: "cleared", parent: "SHOP-1" },
      ],
    });

    expect(r.links).toHaveLength(4);
  });

  it("fails when every ticket failed, with the first failure's code", async () => {
    const f = await family();
    const e = await failure(run(f, { tickets: ["SHOP-98", "SHOP-99"], clear: true }));
    expect(e?.code).toBe("not_found");
    expect(e?.message).toMatch(/SHOP-98: [\s\S]*\nSHOP-99: /);
  });

  it("lets an error that is not the tracker's through", async () => {
    const f = await family();
    f.tracker.getIssue = () => Promise.reject(new Error("boom"));
    await expect(run(f, { tickets: ["SHOP-2"], clear: true })).rejects.toThrow("boom");
  });
});
