import { fakeEnv } from "@outstaff/testing.agent";
import { describe, expect, it } from "vitest";
import { findVerb, runVerb } from "#/verbs/index.js";
import type { DeclaredHandBack } from "#/verbs/types.js";

/** An item of the given kind, and the statuses its agent stated. */
function item(kind: string | undefined) {
  const said: DeclaredHandBack[] = [];
  const { env } = fakeEnv();
  const withItem = kind
    ? { ...env, handBack: { kind, declare: (s: DeclaredHandBack) => void said.push(s) } }
    : env;

  const run = (status: string) =>
    runVerb(findVerb("handback")!, withItem, { status }, { workItemId: "w1" });

  return { said, run };
}

describe("ost handback", () => {
  it("states how the item ends", async () => {
    const i = item("assigned");
    const out = await i.run("blocked");
    await i.run("done");
    expect(i.said).toEqual(["blocked", "done"]);
    expect(JSON.stringify(out)).toContain("handed back as blocked");
  });

  it("lets a comment round finish silently", async () => {
    const i = item("ticket_comment");
    await i.run("silent");
    expect(i.said).toEqual(["silent"]);
  });

  it("refuses a silent finish for work on a ticket", async () => {
    const i = item("assigned");
    await expect(i.run("silent")).rejects.toThrow("cannot finish silently");
    expect(i.said).toEqual([]);
  });

  it("refuses outside a work item", async () => {
    await expect(item(undefined).run("done")).rejects.toThrow("Only a work item hands back");
  });
});
