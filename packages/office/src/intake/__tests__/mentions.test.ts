import { createFakeKnowledge, createFakeVcs } from "@outstaff/core/fakes";
import { describe, expect, it, vi } from "vitest";
import { human, setup } from "./test-support.js";

// The adapters parse `@name` out of a comment; intake maps the names to the team's agents.

const tracked = (events: Awaited<ReturnType<typeof setup>>["events"]) =>
  events.filter((e) => e.event.type === "ticket.commented").map((e) => e.event);

describe("mentions in a ticket comment", () => {
  it("become the handles of the agents named, by tracker username, handle or name, first mention first", async () => {
    const { tracker, intake, events } = await setup({ trackerActor: human("u1", "dana") });
    const issue = await tracker.createIssue({ title: "Search", body: "" });
    await tracker.comment(issue.key, "@Noor then @u-sam, and @dana, @nobody and @NOOR again");
    await intake.pollOnce();

    expect(tracked(events)[0]?.data["mentions"]).toEqual(["noor", "sam"]);
  });

  it("are absent when the comment names no agent of the team", async () => {
    const { tracker, intake, events } = await setup({ trackerActor: human("u1", "dana") });
    const issue = await tracker.createIssue({ title: "Search", body: "" });
    await tracker.comment(issue.key, "@dana and @nobody");
    await intake.pollOnce();

    expect(tracked(events)[0]?.data).not.toHaveProperty("mentions");
  });

  it("in an agent's comment name the other agents, never the agent itself", async () => {
    const { tracker, intake, events } = await setup({
      trackerActor: { id: "u-sam", name: "Sam", username: "u-sam", kind: "agent" },
    });

    const issue = await tracker.createIssue({ title: "Search", body: "" });
    await tracker.comment(issue.key, "@noor please review");
    await tracker.comment(issue.key, "@sam: note to self");
    await tracker.comment(issue.key, "@Sam and @noor");
    await intake.pollOnce();

    expect(tracked(events)[0]).toMatchObject({ actor: { kind: "agent", id: "sam" } });
    expect(tracked(events).map((e) => e.data["mentions"])).toEqual([["noor"], undefined, ["noor"]]);
  });

  it("are dropped from a comment by an automation", async () => {
    const { tracker, intake, events } = await setup({
      trackerActor: { id: "u-bot", name: "Build Bot", kind: "agent" },
    });

    const issue = await tracker.createIssue({ title: "Search", body: "" });
    await tracker.comment(issue.key, "@noor the build is green");
    await intake.pollOnce();

    expect(tracked(events)[0]).toMatchObject({ actor: { kind: "automation" } });
    expect(tracked(events)[0]?.data).not.toHaveProperty("mentions");
  });

  it("match what the tracker calls the member the team file names", async () => {
    const { tracker, intake, events } = await setup({ trackerActor: human("u1", "dana") });
    await tracker.seed.member({ name: "Sam Duarte", username: "u-sam", kind: "agent" });
    const issue = await tracker.createIssue({ title: "Search", body: "" });
    await tracker.comment(issue.key, "this is for @sam.duarte");
    await intake.pollOnce();

    expect(tracked(events)[0]?.data["mentions"]).toEqual(["sam"]);
  });
});

describe("mentions in a document comment", () => {
  it("become the handles of the agents named", async () => {
    const knowledge = createFakeKnowledge({ author: "dana" });
    const open: { id: string; ticket?: string }[] = [];
    const docs = { open: vi.fn<(limit: number) => { id: string; ticket?: string }[]>(() => open) };
    const { intake, events } = await setup({ ports: { vcs: createFakeVcs(), knowledge }, docs });
    const doc = await knowledge.create({ path: "design/cart", title: "Cart", body: "The cart" });
    open.push({ id: doc.id, ticket: "SHOP-1" });
    const c = await knowledge.comment(doc.id, {
      body: "@noor what about this?",
      anchorText: "cart",
    });

    await knowledge.reply(c.id, "thanks @sam, @nobody");
    await intake.pollOnce();

    const found = events.filter((e) => e.event.type === "doc.commented").map((e) => e.event);
    expect(found.map((e) => e.data["mentions"])).toEqual([["noor"], ["sam"]]);
  });
});
