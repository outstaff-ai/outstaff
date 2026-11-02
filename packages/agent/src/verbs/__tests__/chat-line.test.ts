import { describe, expect, it } from "vitest";
import { findVerb, runVerb } from "#/verbs/index.js";
import { fakeEnv } from "@outstaff/testing.agent";

/** A chat session of sam's: `c1` is a chat item. */
function chatSession() {
  const f = fakeEnv();
  f.office.work = async () => [{ id: "c1", title: "Chat", status: "active", kind: "chat" }];
  const run = (name: string, input: Record<string, unknown>) =>
    runVerb(findVerb(name)!, f.env, input, { workItemId: "c1" });

  return { ...f, run };
}

describe("the agent's line for the chat reply", () => {
  it("goes with an attached request, trimmed, and a teammate's handle becomes their name", async () => {
    const f = chatSession();
    await f.run("work.attach", { target: "11", say: "  Reworking it now with @mira.  " });
    expect(f.office.attached).toEqual([
      { workItemId: "c1", target: "11", confirmed: false, say: "Reworking it now with Mira." },
    ]);
  });

  it("goes with a ticket filed as the session's work", async () => {
    const f = chatSession();
    await f.run("ticket.create", { title: "Export orders", say: "Will do, starting next." });
    expect(f.office.linked).toEqual([
      {
        workItemId: "c1",
        ticket: "SHOP-1",
        request: "Export orders",
        say: "Will do, starting next.",
      },
    ]);
  });

  it("is left out when not given", async () => {
    const f = chatSession();
    await f.run("work.attach", { target: "11" });
    expect(f.office.attached[0]).not.toHaveProperty("say");
  });

  it("refuses a mention of anyone but a configured human, before anything is filed", async () => {
    const f = chatSession();
    await expect(
      f.run("ticket.create", { title: "Export", say: "Asking @stranger." }),
    ).rejects.toMatchObject({
      code: "invalid",
      message: expect.stringMatching(/@stranger/) as string,
    });

    await expect(f.run("work.attach", { target: "11", say: "Ping @stranger." })).rejects.toThrow(
      /@stranger/,
    );

    expect(await f.tracker.listIssues({})).toEqual([]);
    expect(f.office.checked).toEqual([]);
    expect(f.office.attached).toEqual([]);
  });

  it("is one short line", async () => {
    const f = chatSession();
    await expect(f.run("work.attach", { target: "11", say: "On it.\nMore." })).rejects.toThrow(
      /One line/,
    );

    await expect(f.run("work.attach", { target: "11", say: "x".repeat(201) })).rejects.toThrow(
      /say/,
    );

    await expect(f.run("work.attach", { target: "11", say: "   " })).rejects.toThrow(/say/);
  });

  it("is ignored outside a chat session", async () => {
    const f = fakeEnv();
    await runVerb(findVerb("ticket.create")!, f.env, { title: "Plain", say: "Hi @stranger." });
    expect(f.office.linked).toEqual([]);
  });
});
