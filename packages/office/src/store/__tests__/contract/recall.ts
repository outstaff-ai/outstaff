import { expect, it } from "vitest";
import type { ContractContext } from "#/store/__tests__/contract.types.js";
import type { NewMoment } from "#/store/types.js";

const T = (minute: number) => `2026-10-01T10:${String(minute).padStart(2, "0")}:00.000Z`;

const comment = (key: string, at: string, subject: NewMoment["subject"], text: string) => ({
  key,
  person: null,
  at,
  kind: "ticket.commented",
  subject,
  actor: "ada.admin",
  actorName: "Ada Admin",
  text,
  url: `https://tracker.acme.example/${key}`,
});

/** Opens the store on a clock the test moves, and returns the setter. */
async function clocked(ctx: ContractContext) {
  let now = new Date(T(0));
  await ctx.open({ now: () => now });
  return (minute: number) => {
    now = new Date(T(minute));
  };
}

/** `ost recall`: an agent's history, searched in full text, scoped to what the agent saw. */
export function recallCases(ctx: ContractContext): void {
  it("records work items, journal entries and outcomes as the agent's moments, and finds them in any form", async () => {
    const at = await clocked(ctx);
    const item = await ctx.store.enqueue({
      person: "sam",
      kind: "assigned",
      title: "Greet visitors on the landing page",
      trigger: "human",
      subject: { type: "ticket", ref: "ACME-1" },
    });

    at(1);
    await ctx.store.appendJournal(item.id, "office", "Keep the greetings short.");
    at(2);
    const run = await ctx.store.startRun(item.id);
    at(3);
    await ctx.store.finishRun(run.id, { outcome: "Opened the greeting pull request." });

    const found = await ctx.store.searchMoments({ person: "sam", text: "greeting", limit: 10 });
    expect(found.map((m) => [m.kind, m.at, m.text])).toEqual([
      ["outcome", T(3), "Opened the greeting pull request."],
      ["journal", T(1), "Keep the greetings short."],
      ["item", T(0), "Greet visitors on the landing page"],
    ]);

    expect(found[1]).toMatchObject({
      person: "sam",
      subject: { type: "ticket", ref: "ACME-1" },
      workItemId: item.id,
      actor: "office",
      actorName: null,
      url: null,
    });

    expect(await ctx.store.searchMoments({ person: "kofi", text: "greeting", limit: 10 })).toEqual(
      [],
    );

    const page = { person: "sam", text: "greeting", limit: 1 };
    expect((await ctx.store.searchMoments(page)).map((m) => m.kind)).toEqual(["outcome"]);
    expect(
      (await ctx.store.searchMoments({ ...page, before: T(3), limit: 5 })).map((m) => m.kind),
    ).toEqual(["journal", "item"]);

    expect(
      (await ctx.store.searchMoments({ ...page, since: T(1), limit: 5 })).map((m) => m.kind),
    ).toEqual(["outcome", "journal"]);
  });

  it("shows an event about a ticket, pull request or document only to agents whose work refers to it", async () => {
    await ctx.store.enqueue({
      person: "sam",
      kind: "assigned",
      title: "Landing page",
      trigger: "human",
      subject: { type: "ticket", ref: "ACME-1" },
      refs: [{ type: "pr", ref: "git.acme.example/acme/app#12", role: "created", source: "pr" }],
    });

    await ctx.store.recordMoment(
      comment("e1", T(1), { type: "ticket", ref: "ACME-1" }, "The banner text is fine."),
    );

    await ctx.store.recordMoment({
      ...comment("e2", T(2), { type: "pr", ref: "git.acme.example/acme/app#12" }, "Banner ok."),
      kind: "pr.review_submitted",
    });

    await ctx.store.recordMoment(
      comment("e3", T(3), { type: "ticket", ref: "ACME-9" }, "Another banner."),
    );

    // Recording the same moment again changes nothing.
    await ctx.store.recordMoment({ ...comment("e1", T(4), null, "banner changed") });

    const sam = await ctx.store.searchMoments({ person: "sam", text: "banner", limit: 10 });
    expect(sam.map((m) => m.key)).toEqual(["e2", "e1"]);
    expect(sam[1]).toMatchObject({
      at: T(1),
      actorName: "Ada Admin",
      url: "https://tracker.acme.example/e1",
    });

    expect(await ctx.store.searchMoments({ person: "kofi", text: "banner", limit: 10 })).toEqual(
      [],
    );
  });

  it("keeps an agent's chat to that agent, even in a thread another agent's work refers to", async () => {
    const thread = { type: "chat_thread", ref: "C1:100.1" };
    await ctx.store.enqueue({
      person: "kofi",
      kind: "chat",
      title: "Chat: colours",
      trigger: "human",
      refs: [{ ...thread, type: "chat_thread", role: "trigger", source: "chat" }],
    });

    await ctx.store.recordMoment({
      key: "chat:sam",
      person: "sam",
      at: T(1),
      kind: "chat.message",
      subject: thread,
      actor: "U1",
      text: "Private: the banner budget.",
    });

    expect(await ctx.store.searchMoments({ person: "kofi", text: "banner", limit: 10 })).toEqual(
      [],
    );

    expect(
      (await ctx.store.searchMoments({ person: "sam", text: "budget", limit: 10 })).map(
        (m) => m.key,
      ),
    ).toEqual(["chat:sam"]);
  });

  it("narrows to moments with a person, and about a ticket, its pull requests and the chat that named it", async () => {
    const at = await clocked(ctx);
    const ticket = { type: "ticket", ref: "ACME-1" };
    const pr = { type: "pr", ref: "git.acme.example/acme/app#12" };
    const thread = { type: "chat_thread", ref: "D1:200.1" };
    await ctx.store.enqueue({
      person: "sam",
      kind: "assigned",
      title: "Landing banner",
      trigger: "human",
      subject: ticket,
      refs: [{ type: "pr", ref: pr.ref, role: "created", source: "pr" }],
    });

    at(1);
    await ctx.store.enqueue({
      person: "sam",
      kind: "chat",
      title: "Chat: banner colours",
      trigger: "human",
      refs: [
        { type: "chat_thread", ref: thread.ref, role: "trigger", source: "chat" },
        { type: "ticket", ref: "ACME-1", role: "mentioned", source: "chat" },
      ],
    });

    const other = await ctx.store.enqueue({
      person: "sam",
      kind: "assigned",
      title: "Footer banner",
      trigger: "human",
      subject: { type: "ticket", ref: "ACME-7" },
    });

    at(2);
    await ctx.store.recordMoment(comment("c1", T(3), pr, "Banner contrast is low."));
    await ctx.store.recordMoment({
      key: "m1",
      person: "sam",
      at: T(4),
      kind: "chat.message",
      subject: thread,
      actor: "U0ADA00001",
      actorName: "Ada Admin",
      text: "Make the banner blue.",
    });

    await ctx.store.appendJournal(other.id, "office", "Banner goes at the bottom.");
    const about = await ctx.store.searchMoments({
      person: "sam",
      text: "banner",
      about: [ticket],
      limit: 10,
    });

    expect(about.map((m) => m.text)).toEqual([
      "Make the banner blue.",
      "Banner contrast is low.",
      "Chat: banner colours",
      "Landing banner",
    ]);

    const withAda = await ctx.store.searchMoments({
      person: "sam",
      text: "banner",
      with: ["u0ada00001", "ADA.ADMIN"],
      limit: 10,
    });

    expect(withAda.map((m) => m.key)).toEqual(["m1", "c1"]);
    const byName = await ctx.store.searchMoments({
      person: "sam",
      text: "banner",
      with: ["ada admin"],
      limit: 10,
    });

    expect(byName.map((m) => m.key)).toEqual(["m1", "c1"]);
  });

  it("reads the search as words, phrases, or and exclusions, and never as query syntax", async () => {
    const at = await clocked(ctx);
    const item = await ctx.store.enqueue({
      person: "sam",
      kind: "assigned",
      title: "Cart survives a deploy",
      trigger: "human",
    });

    at(1);
    await ctx.store.appendJournal(item.id, "sam", "Kept the cart in the session store.");
    const search = async (text: string) =>
      (await ctx.store.searchMoments({ person: "sam", text, limit: 10 })).map((m) => m.kind);

    expect(await search('"session store"')).toEqual(["journal"]);
    expect(await search('"store session"')).toEqual([]);
    expect(await search("cart -session")).toEqual(["item"]);
    expect(await search("deploy or session")).toEqual(["journal", "item"]);
    expect(await search('NEAR( AND "unclosed *:^ cart')).toEqual([]);
    expect(await search("cart*")).toEqual(["journal", "item"]);
    expect(await search("")).toEqual([]);
    expect(await search("-cart")).toEqual([]);
  });

  it("lists recorded events by the time they were received, never splitting events received at once", async () => {
    let now = new Date(T(1));
    await ctx.open({ now: () => now });
    const record = (id: string) =>
      ctx.store.recordEvent({ source: "tracker", externalId: id, type: "t", payload: { id } });

    await record("a");
    await record("b");
    now = new Date(T(2));
    await record("c");
    const ids = async (after?: string) =>
      (await ctx.store.listEventsAfter({ after, limit: 1 })).map((e) => e.externalId);

    expect(await ids()).toEqual(["a", "b"]);
    expect(await ids(T(1))).toEqual(["c"]);
    expect(await ids(T(2))).toEqual([]);
    expect((await ctx.store.listEventsAfter({ limit: 5 }))[0]).toMatchObject({
      payload: { id: "a" },
      receivedAt: T(1),
    });
  });
}
