import { describe, expect, it } from "vitest";
import { findVerb, runVerb } from "#/verbs/index.js";
import { similarTitles, titleWords } from "#/verbs/ticket-similar.js";
import { fakeEnv } from "@outstaff/testing.agent";

const create = (f: ReturnType<typeof fakeEnv>, input: Record<string, unknown>) =>
  runVerb(findVerb("ticket.create")!, f.env, { body: "", ...input });

describe("similar titles", () => {
  it("compares the words that count, without case, punctuation or stop words", () => {
    expect(titleWords("Add a status page, for the shop!")).toEqual([
      "add",
      "status",
      "page",
      "shop",
    ]);

    expect(similarTitles("Add a status page", "add status page")).toBe(true);
    expect(similarTitles("Cache search results in Redis", "Cache the search results")).toBe(true);
    expect(similarTitles("Add a status page", "Add a login page")).toBe(false);
    expect(similarTitles("Status page", "Status")).toBe(false);
    expect(similarTitles("the", "a")).toBe(false);
  });
});

describe("ticket.create near-duplicate warning", () => {
  it("creates the ticket and warns, listing the open ticket with a similar title", async () => {
    const f = fakeEnv();
    const old = await f.tracker.createIssue({ title: "Cache search results in Redis", body: "" });
    const r = await create(f, { title: "Cache the search results in Redis" });

    expect((await f.tracker.getIssue("SHOP-2")).title).toBe("Cache the search results in Redis");
    expect(r.text).toContain("Warning: open tickets with a similar title:");
    expect(r.text).toContain(`- ${old.key}: Cache search results in Redis`);
    expect(r.text).toContain("change that ticket instead");
    expect(r.links).toContain(f.tracker.links.issue(old.key));
    expect(r.data).toMatchObject({
      similar: [{ key: old.key, title: "Cache search results in Redis" }],
    });
  });

  it("does not warn about a done or canceled ticket, a different title, or the parent", async () => {
    const f = fakeEnv();
    const done = await f.tracker.createIssue({ title: "Add a status page", body: "" });
    await f.tracker.transition(done.key, "done");
    const canceled = await f.tracker.createIssue({ title: "Add the status page", body: "" });
    await f.tracker.transition(canceled.key, "canceled");
    await f.tracker.createIssue({ title: "Add a login page", body: "" });
    const parent = await f.tracker.createIssue({ title: "Status page", body: "" });

    const r = await create(f, { title: "Status page", parent: parent.key });
    expect(r.text).not.toContain("Warning");
    expect(r.data).not.toHaveProperty("similar");
  });

  it("still creates the ticket when the search fails", async () => {
    const f = fakeEnv();
    await f.tracker.createIssue({ title: "Add a status page", body: "" });
    f.tracker.search = async () => {
      throw new Error("search is down");
    };

    const r = await create(f, { title: "Add a status page" });
    expect(r.text).toContain("Created SHOP-2.");
    expect(r.text).not.toContain("Warning");
  });
});
