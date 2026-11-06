import { fakeEnv } from "@outstaff/testing.agent";
import { describe, expect, it } from "vitest";
import { findVerb, runVerb } from "#/verbs/index.js";
import type { DeclaredHandBack } from "#/verbs/types.js";

/** An item of the given kind, and the statuses its agent stated. */
function item(kind: string | undefined) {
  const said: DeclaredHandBack[] = [];
  const messages: (string | undefined)[] = [];
  const { env } = fakeEnv();
  const declare = (s: DeclaredHandBack, message?: string) => {
    said.push(s);
    messages.push(message);
  };

  const withItem = kind ? { ...env, handBack: { kind, declare } } : env;
  const run = (status: string, message?: string) =>
    runVerb(
      findVerb("handback")!,
      withItem,
      { status, ...(message === undefined ? {} : { message }) },
      { workItemId: "w1" },
    );

  return { said, messages, run };
}

describe("ost handback", () => {
  it("states how the item ends", async () => {
    const i = item("assigned");
    const out = await i.run("blocked");
    await i.run("done");
    expect(i.said).toEqual(["blocked", "done"]);
    expect(JSON.stringify(out)).toContain("handed back as blocked");
  });

  it("takes the agent's message for the human with the status", async () => {
    const i = item("assigned");
    const out = await i.run("done", "  Added the preview step; nothing needed from you.  ");
    await i.run("done");
    expect(i.messages).toEqual(["Added the preview step; nothing needed from you.", undefined]);
    expect(JSON.stringify(out)).toContain("with your message");
    await expect(i.run("done", " ")).rejects.toThrow(/message/);
  });

  it("lets a comment round finish silently", async () => {
    const i = item("ticket_comment");
    await i.run("silent");
    expect(i.said).toEqual(["silent"]);
  });

  it("lets work on a ticket finish silently: the office checks it waits on work in flight", async () => {
    const i = item("assigned");
    await i.run("silent");
    expect(i.said).toEqual(["silent"]);
  });

  it("refuses outside a work item", async () => {
    await expect(item(undefined).run("done")).rejects.toThrow("Only a work item hands back");
  });
});
