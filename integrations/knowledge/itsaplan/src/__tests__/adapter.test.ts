import { silentLogger, type AdapterContext } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { API_KEY, secretMap, team } from "@outstaff/testing.itsaplan";
import { knowledgeOptions } from "../index.js";
import { createItsaplanKnowledge } from "../knowledge.js";
import { createItsaplanFake } from "../testing/itsaplan-fake.js";

const knowledgeCtx = (fake: ReturnType<typeof createItsaplanFake>) =>
  ({
    options: knowledgeOptions.parse({}),
    secrets: secretMap({ ITSAPLAN_API_KEY: API_KEY }),
    team,
    log: silentLogger,
    fetch: fake.fetch,
    now: () => new Date("2026-01-01T00:00:00Z"),
  }) satisfies AdapterContext<ReturnType<typeof knowledgeOptions.parse>>;

describe("tracker", () => {
  it("takes the workspace from the project and lets doc_url override the default", async () => {
    const fake = createItsaplanFake({ teamRef: "globex" });
    const kb = await createItsaplanKnowledge(knowledgeCtx(fake));
    await kb.search("x");
    expect(kb.links.doc("3")).toBe("https://tracker.acme.example/globex/SHOP/docs/3");
    const custom = await createItsaplanKnowledge({
      ...knowledgeCtx(fake),
      options: knowledgeOptions.parse({ doc_url: "{url}/{workspace}/d/{id}" }),
    });

    await custom.search("x");
    expect(custom.links.doc("3")).toBe("https://tracker.acme.example/globex/d/3");
  });

  it("links a comment to its parent unless a comment template is set", async () => {
    const fake = createItsaplanFake();
    const kb = await createItsaplanKnowledge({
      ...knowledgeCtx(fake),
      options: knowledgeOptions.parse({
        doc_comment_url: "{url}/{workspace}/{project}/docs/{id}#c-{commentId}",
      }),
    });

    await kb.search("");
    expect(kb.links.comment!("3", "3:9")).toBe("https://tracker.acme.example/acme/SHOP/docs/3#c-9");

    const plain = await createItsaplanKnowledge(knowledgeCtx(fake));
    await plain.search("");
    expect(plain.links.comment!("3", "3:9")).toBe(plain.links.doc("3"));
  });

  it("builds document links without the workspace until a read resolves it", async () => {
    const fake = createItsaplanFake({ teamRef: "globex" });
    let up = false;
    const flaky: typeof fake.fetch = async (input, init) => {
      if (!up) {
        throw new TypeError("fetch failed");
      }

      return fake.fetch(input, init);
    };

    let t = Date.parse("2026-01-01T00:00:00Z");
    const kb = await createItsaplanKnowledge({
      ...knowledgeCtx(fake),
      fetch: flaky,
      now: () => new Date(t),
    });

    expect(kb.links.doc("3")).toBe("https://tracker.acme.example/SHOP/docs/3");
    await new Promise((r) => setTimeout(r, 0));
    up = true;
    t += 6_000;
    await kb.search("x");
    expect(kb.links.doc("3")).toBe("https://tracker.acme.example/globex/SHOP/docs/3");
  });
});

describe("knowledge", () => {
  it("resolves pages made in the web app by their titles, and keeps replies tied to their document", async () => {
    const fake = createItsaplanFake();
    const kb = await createItsaplanKnowledge(knowledgeCtx(fake));
    fake.state.docs.push(
      {
        id: 90,
        parentId: null,
        title: "Handbook",
        metadata: {},
        version: 1,
        content: "",
        contentJson: null,
        createdAt: "",
        updatedAt: "",
      },
      {
        id: 91,
        parentId: 90,
        title: "Onboarding",
        metadata: {},
        version: 3,
        content: "Welcome aboard, friend",
        contentJson: null,
        createdAt: "",
        updatedAt: "",
      },
    );

    const doc = await kb.get("handbook/onboarding");
    expect(doc).toMatchObject({ id: "91", path: "Handbook/Onboarding", version: "3" });
    // no editor JSON yet: the first comment writes it, then anchors
    const c = await kb.comment(doc.id, { body: "nice", anchorText: "aboard" });
    expect(c.id).toMatch(/^91:/);
    expect(fake.state.docs.find((d) => d.id === 91)?.contentJson).not.toBeNull();
    const r = await kb.reply(c.id, "thanks");
    expect(r.parentId).toBe(c.id);
    await kb.resolve(c.id);
    expect((await kb.comments(doc.id)).find((x) => x.id === c.id)?.resolved).toBe(true);
  });

  it("creates parent pages for a nested path and stores the path", async () => {
    const fake = createItsaplanFake();
    const kb = await createItsaplanKnowledge(knowledgeCtx(fake));
    await kb.create({ path: "eng/runbooks/deploy", title: "Deploy", body: "# Steps\n\n- one" });
    expect(fake.state.docs.map((d) => [d.title, d.parentId])).toEqual([
      ["eng", null],
      ["runbooks", 1],
      ["Deploy", 2],
    ]);

    expect((await kb.get("eng/runbooks")).title).toBe("runbooks");
    expect(fake.state.docs[2]?.contentJson?.content?.[0]?.type).toBe("heading");
    await kb.search("x");
    expect(kb.links.doc("3")).toBe("https://tracker.acme.example/acme/SHOP/docs/3");
  });

  it("updates against the current version when no baseVersion is given and writes both bodies", async () => {
    const fake = createItsaplanFake();
    const kb = await createItsaplanKnowledge(knowledgeCtx(fake));
    const doc = await kb.create({ path: "a", title: "A", body: "one" });
    const next = await kb.update(doc.id, { body: "two" });
    expect(next.version).toBe("2");
    expect(fake.state.docs[0]?.contentJson?.content?.[0]?.content?.[0]?.text).toBe("two");
  });

  it("anchors a comment on the first text when no anchorText is given, and refuses unknown text", async () => {
    const fake = createItsaplanFake();
    const kb = await createItsaplanKnowledge(knowledgeCtx(fake));
    const doc = await kb.create({ path: "n", title: "N", body: "First line\n\nSecond" });
    expect((await kb.comment(doc.id, { body: "hm" })).anchorText).toBe("First line");
    await expect(kb.comment(doc.id, { body: "x", anchorText: "absent" })).rejects.toMatchObject({
      code: "invalid",
    });

    const empty = await kb.create({ path: "e", title: "E", body: "" });
    await expect(kb.comment(empty.id, { body: "x" })).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("knowledge events", () => {
  const setup = async () => {
    const fake = createItsaplanFake();
    const kb = await createItsaplanKnowledge(knowledgeCtx(fake));
    const doc = await kb.create({
      path: "design/cart",
      title: "Cart design",
      body: "Keep the cart\n\nin the session",
    });

    return { fake, kb, doc };
  };

  it("parses the @mentions of a document comment and of a reply", async () => {
    const { kb, doc } = await setup();
    const base = await kb.events([doc.id]);
    const c = await kb.comment(doc.id, {
      body: "@lena can you check this?",
      anchorText: "the cart",
    });

    await kb.reply(c.id, "thanks @sam and @lena");

    const page = await kb.events([doc.id], base.cursor);
    expect(page.events.map((e) => e.data.mentions)).toEqual([["lena"], ["sam", "lena"]]);
  });

  it("reads the comments of the named documents, oldest first, with the author's identity and the anchor", async () => {
    const { kb, doc } = await setup();
    const other = await kb.create({ path: "design/other", title: "Other", body: "Elsewhere" });
    const base = await kb.events([doc.id, other.id]);
    const c = await kb.comment(doc.id, { body: "why a session?", anchorText: "the cart" });
    const r = await kb.reply(c.id, "so it survives a reload");
    await kb.comment(other.id, { body: "not asked for", anchorText: "Elsewhere" });

    const page = await kb.events([doc.id], base.cursor);
    expect(page.events.map((e) => e.data.body)).toEqual([
      "why a session?",
      "so it survives a reload",
    ]);

    expect(page.events[0]).toMatchObject({
      externalId: expect.stringContaining(c.id),
      type: "commented",
      doc: doc.id,
      title: "Cart design",
      url: doc.url,
      actor: { id: "u-sam", kind: "agent" },
      data: { commentId: c.id, anchorText: "the cart" },
    });

    expect(page.events[0]?.data.mentions).toBeUndefined();
    expect(page.events[1]?.data.parentId).toBe(c.id);
    expect(r.id).toBe(page.events[1]?.data.commentId);
    expect(page.events.every((e) => e.doc === doc.id)).toBe(true);
  });

  it("re-reads the overlap without handing back what the baseline saw, and dedupes by external id", async () => {
    const { kb, doc } = await setup();
    const old = await kb.comment(doc.id, { body: "old", anchorText: "Keep" });
    const first = await kb.events([doc.id]);
    // The first call without a cursor lists the recent history; the office only keeps the cursor.
    expect(first.events.map((e) => e.data.commentId)).toEqual([old.id]);
    expect((await kb.events([doc.id], first.cursor)).events).toEqual([]);

    const fresh = await kb.comment(doc.id, { body: "new", anchorText: "session" });
    const next = await kb.events([doc.id], first.cursor);
    expect(next.events.map((e) => e.data.commentId)).toEqual([fresh.id]);
    const again = await kb.events([doc.id], next.cursor);
    // The overlap returns it once more with the same external id.
    expect(again.events.map((e) => e.externalId)).toEqual(next.events.map((e) => e.externalId));
  });

  it("orders by time, never by id", async () => {
    const { fake, kb, doc } = await setup();
    const base = await kb.events([doc.id]);
    const a = await kb.comment(doc.id, { body: "first", anchorText: "Keep" });
    const b = await kb.comment(doc.id, { body: "second", anchorText: "session" });
    // The ids say b then a, the times say a then b.
    const rows = fake.state.docComments;
    rows.find((x) => `${doc.id}:${x.id}` === a.id)!.id = "z-late-id";
    rows.find((x) => `${doc.id}:${x.id}` === b.id)!.id = "a-early-id";
    const page = await kb.events([doc.id], base.cursor);
    expect(page.events.map((e) => e.data.body)).toEqual(["first", "second"]);
  });

  it("skips a document that is gone, baselines an unusable cursor, and rejects garbage", async () => {
    const { kb, doc } = await setup();
    await kb.comment(doc.id, { body: "x", anchorText: "Keep" });
    expect((await kb.events(["999", doc.id])).events).toHaveLength(1);
    const old = await kb.events([doc.id], JSON.stringify({ id: 5 }));
    expect(old.events).toEqual([]);
    await expect(kb.events([doc.id], "not json")).rejects.toMatchObject({ code: "invalid" });
  });
});
