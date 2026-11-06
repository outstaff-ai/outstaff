import { PortError } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { createFakeOffice, findVerb, runVerb } from "#/verbs/index.js";
import type { OfficeWorkItem } from "#/verbs/office.types.js";
import { fakeEnv } from "@outstaff/testing.agent";

/** sam's env, running in the work item `w1` the office describes as `current`. */
async function inRound(current: Omit<OfficeWorkItem, "id" | "title" | "status">) {
  const f = fakeEnv();
  f.env.office = createFakeOffice({
    items: [{ id: "w1", title: "The round", status: "active", ...current }],
  });

  const issue = await f.tracker.createIssue({ title: "Search page", body: "" });
  await f.tracker.transition(issue.key, "review");
  const move = (to: string, ctx: { workItemId?: string } = { workItemId: "w1" }) =>
    runVerb(findVerb("ticket.move")!, f.env, { key: issue.key, to }, ctx);

  const status = async () => (await f.tracker.getIssue(issue.key)).status.canonical;
  return { ...f, issue, move, status };
}

describe("ticket.move to active", () => {
  it("is refused from a chat session, pointing to ost work attach, and leaves the ticket as it is", async () => {
    const { issue, move, status } = await inRound({ kind: "chat" });
    const err = await move("active").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortError);
    expect(err).toMatchObject({ code: "invalid" });
    expect((err as Error).message).toContain(`ost work attach ${issue.key} --confirmed`);
    expect((err as Error).message).toContain("tell the requester in the thread");
    expect(await status()).toBe("review");
  });

  it("is refused from a round on another ticket", async () => {
    const { move, status } = await inRound({ kind: "assigned", ticketKey: "SHOP-99" });
    await expect(move("active")).rejects.toMatchObject({ code: "invalid" });
    expect(await status()).toBe("review");
  });

  it("moves the ticket from a round on it, or on its parent", async () => {
    const own = await inRound({ kind: "assigned" });
    own.env.office = createFakeOffice({
      items: [{ id: "w1", title: "r", status: "active", ticketKey: own.issue.key.toLowerCase() }],
    });

    await own.move("active");
    expect(await own.status()).toBe("active");

    const sub = await inRound({ kind: "assigned", ticketKey: "SHOP-50" });
    sub.tracker.parents.set(sub.issue.key, "SHOP-50");
    await sub.move("active");
    expect(await sub.status()).toBe("active");
  });

  it("leaves a ticket already active, a call outside a round and a move to another status alone", async () => {
    const f = await inRound({ kind: "chat" });
    await f.move("review");
    await f.move("active", {});
    expect(await f.status()).toBe("active");
    await f.move("active");
    expect(await f.status()).toBe("active");

    delete f.env.office;
    await f.tracker.transition(f.issue.key, "review");
    await f.move("active");
    expect(await f.status()).toBe("active");
  });
});
