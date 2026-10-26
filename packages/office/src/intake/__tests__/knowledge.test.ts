import { createFakeKnowledge, createFakeVcs } from "@outstaff/core/fakes";
import { describe, expect, it, vi } from "vitest";
import { DOC_POLL_LIMIT } from "../sources.js";
import { setup } from "../test-support.js";

async function world(author = "dana") {
  const knowledge = createFakeKnowledge({ author });
  const open: { id: string; ticket?: string }[] = [];
  const docs = { open: vi.fn<(limit: number) => { id: string; ticket?: string }[]>(() => open) };
  const s = await setup({ ports: { vcs: createFakeVcs(), knowledge }, docs });
  const doc = await knowledge.create({
    path: "design/cart",
    title: "Cart design",
    body: "Keep the cart in the session",
  });

  return { ...s, knowledge, doc, open, docs };
}

describe("the knowledge source", () => {
  it("turns a comment and a reply on a document of open work into doc.commented, carrying the ticket", async () => {
    const { knowledge, doc, open, intake, events } = await world();
    open.push({ id: doc.id, ticket: "SHOP-1" });
    const c = await knowledge.comment(doc.id, { body: "Why a session?", anchorText: "the cart" });
    await knowledge.reply(c.id, "Please explain");
    await intake.pollOnce();

    const found = events.filter((e) => e.meta.source === "knowledge");
    expect(found.map((e) => e.event.type)).toEqual(["doc.commented", "doc.commented"]);
    expect(found[0]!.event).toMatchObject({
      subject: { doc: doc.id, ticket: "SHOP-1" },
      actor: { kind: "human", id: "dana" },
      data: {
        docId: doc.id,
        title: "Cart design",
        url: doc.url,
        commentId: c.id,
        anchorText: "the cart",
        body: "Why a session?",
      },
    });

    expect(found[0]!.meta.trusted).toBe(true);
    expect(found[1]!.event.data).toMatchObject({ parentId: c.id });
  });

  it("knows the agent's own comments as an agent's, and a document without a ticket", async () => {
    const { knowledge, doc, open, intake, events } = await world("u-sam");
    open.push({ id: doc.id });
    await knowledge.comment(doc.id, { body: "Done", anchorText: "session" });
    await intake.pollOnce();

    const [only] = events.filter((e) => e.meta.source === "knowledge");
    expect(only!.event.actor).toEqual({ kind: "agent", id: "sam" });
    expect(only!.event.subject).toEqual({ doc: doc.id });
  });

  it("does not hand back what was written before the first poll, and delivers a comment only once", async () => {
    const knowledge = createFakeKnowledge();
    const open: { id: string }[] = [];
    const doc = await knowledge.create({ path: "a", title: "A", body: "text here" });
    await knowledge.comment(doc.id, { body: "old", anchorText: "text" });
    open.push({ id: doc.id });
    const s = await setup({
      ports: { vcs: createFakeVcs(), knowledge },
      docs: { open: () => open },
    });

    await knowledge.comment(doc.id, { body: "new", anchorText: "here" });
    await s.intake.pollOnce();
    await s.intake.pollOnce();
    const bodies = s.events
      .filter((e) => e.meta.source === "knowledge")
      .map((e) => e.event.data["body"]);

    expect(bodies).toEqual(["new"]);
  });

  it("asks for a bounded number of documents, and reads nothing once there are none", async () => {
    const { knowledge, doc, open, docs, intake } = await world();
    const spy = vi.spyOn(knowledge, "events");
    await intake.pollOnce();
    expect(docs.open).toHaveBeenLastCalledWith(DOC_POLL_LIMIT);
    expect(spy).not.toHaveBeenCalled();

    open.push({ id: doc.id });
    await intake.pollOnce();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toEqual([doc.id]);
  });
});
