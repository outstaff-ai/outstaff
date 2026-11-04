import { silentLogger, type AdapterContext } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { API_KEY, secretMap, team } from "@outstaff/testing.itsaplan";
import { createItsaplanFake } from "./fake.js";
import { knowledgeOptions } from "#/index.js";
import { createItsaplanKnowledge } from "#/knowledge.js";

const ctxOf = (fetch: typeof globalThis.fetch) =>
  ({
    options: knowledgeOptions.parse({}),
    secrets: secretMap({ ITSAPLAN_API_KEY: API_KEY }),
    team,
    log: silentLogger,
    fetch,
    now: () => new Date("2026-01-01T00:00:00Z"),
  }) satisfies AdapterContext<ReturnType<typeof knowledgeOptions.parse>>;

describe("linking a document to an initiative", () => {
  it("links it by the document's id and the initiative's, as the API key's member, once", async () => {
    const fake = createItsaplanFake();
    const kb = await createItsaplanKnowledge(ctxOf(fake.fetch));
    const initiative = await fake.knowledgeSeed.initiative!();
    const doc = await kb.create({ path: "plans/monitoring", title: "Monitoring", body: "" });
    expect(await kb.linkInitiative!("plans/monitoring", initiative)).toBe("linked");
    expect(await kb.linkInitiative!(doc.id, initiative)).toBe("already_linked");
    const posts = fake.calls.filter((c) => c.method === "POST" && c.path.endsWith("/initiatives"));
    expect(posts.map((c) => [c.path, c.json])).toEqual([
      [`/projects/SHOP/documents/${doc.id}/initiatives`, { initiativeId: Number(initiative) }],
    ]);

    expect(fake.state.docInitiatives).toEqual([
      { docId: Number(doc.id), initiativeId: Number(initiative), by: "u-sam" },
    ]);

    expect(await kb.initiativeDocs!(initiative)).toEqual([{ id: doc.id, title: "Monitoring" }]);
  });

  it("takes a refused second link as linked already, and passes on any other refusal", async () => {
    const fake = createItsaplanFake();
    let forbidden = false;
    // A listing that misses the link someone made meanwhile, and a key that may not link at all.
    const stale: typeof fetch = (input, init) => {
      const url = String(input);
      if (url.includes("/for-initiative/")) {
        return Promise.resolve(new Response("[]"));
      }

      return url.endsWith("/initiatives") && forbidden
        ? Promise.resolve(new Response(JSON.stringify({ error: "no" }), { status: 403 }))
        : fake.fetch(input, init);
    };

    const kb = await createItsaplanKnowledge(ctxOf(stale));
    const initiative = await fake.knowledgeSeed.initiative!();
    const doc = await kb.create({ path: "plans/monitoring", title: "Monitoring", body: "" });
    expect(await kb.linkInitiative!(doc.id, initiative)).toBe("linked");
    expect(await kb.linkInitiative!(doc.id, initiative)).toBe("already_linked");
    forbidden = true;
    await expect(kb.linkInitiative!(doc.id, initiative)).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});
