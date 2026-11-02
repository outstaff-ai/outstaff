import {
  envSecretSource,
  silentLogger,
  type AdapterContext,
  type DeriveContext,
} from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { API_KEY, secretMap, team } from "@outstaff/testing.itsaplan";
import { createItsaplanFake } from "./fake.js";
import { itsaplanKnowledge, knowledgeOptions } from "#/index.js";
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

async function setup() {
  const fake = createItsaplanFake();
  const kb = await createItsaplanKnowledge(ctxOf(fake.fetch));
  const ticket = await fake.knowledgeSeed.issue!();
  const doc = await kb.create({ path: "design/cart", title: "Cart", body: "" });
  const posts = () => fake.calls.filter((c) => c.method === "POST" && c.path.endsWith("/issues"));

  return { fake, kb, ticket, doc, posts };
}

describe("linking a document on an issue", () => {
  it("links it by the issue's id, as the API key's member, once", async () => {
    const { fake, kb, ticket, doc, posts } = await setup();
    expect(await kb.linkIssue!("design/cart", ticket)).toBe("linked");
    expect(await kb.linkIssue!(doc.id, ticket)).toBe("already_linked");
    const issue = fake.state.issues.find((i) => i.identifier === ticket)!;
    expect(posts().map((c) => [c.path, c.json])).toEqual([
      [`/projects/SHOP/documents/${doc.id}/issues`, { issueId: issue.id }],
    ]);

    expect(fake.state.docIssues).toEqual([
      { docId: Number(doc.id), issueId: issue.id, by: "u-sam" },
    ]);

    expect(await kb.issueDocs!(ticket)).toEqual([{ id: doc.id, title: "Cart" }]);
  });

  it("takes a refused second link as linked already, and passes on any other refusal", async () => {
    const fake = createItsaplanFake();
    let forbidden = false;
    // A listing that misses the link someone made meanwhile, and a key that may not link at all.
    const stale: typeof fetch = (input, init) => {
      const links = String(input).endsWith("/issues");
      if (links && (init?.method ?? "GET") === "GET") {
        return Promise.resolve(new Response("[]"));
      }

      return links && forbidden
        ? Promise.resolve(new Response(JSON.stringify({ error: "no" }), { status: 403 }))
        : fake.fetch(input, init);
    };

    const kb = await createItsaplanKnowledge(ctxOf(stale));
    const ticket = await fake.knowledgeSeed.issue!();
    const doc = await kb.create({ path: "design/cart", title: "Cart", body: "" });
    expect(await kb.linkIssue!(doc.id, ticket)).toBe("linked");
    expect(await kb.linkIssue!(doc.id, ticket)).toBe("already_linked");
    forbidden = true;
    await expect(kb.linkIssue!(doc.id, ticket)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("reports an unknown document or ticket as not found", async () => {
    const { kb, ticket, doc } = await setup();
    await expect(kb.linkIssue!("999", ticket)).rejects.toMatchObject({ code: "not_found" });
    await expect(kb.linkIssue!(doc.id, "SHOP-999")).rejects.toMatchObject({ code: "not_found" });
    await expect(kb.issueDocs!("SHOP-999")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("the document links check", () => {
  const derive = (fetch: typeof globalThis.fetch, scope: "person" | "office" = "person") =>
    ({
      team,
      scope,
      options: {},
      ...(scope === "person"
        ? { person: { handle: "sam", identities: { tracker: "u-sam" } } as never }
        : {}),
      fetch,
      now: () => new Date("2026-01-01T00:00:00Z"),
      warn: () => {},
    }) satisfies DeriveContext;

  const secrets = envSecretSource({ ITSAPLAN_API_KEY: API_KEY }, "/nonexistent");
  // The stand-in has no `/me`; the key's member is sam.
  const checkOf = async ({ fetch: inner, ...ctx }: DeriveContext) => {
    const fetch: typeof globalThis.fetch = (input, init) =>
      String(input).endsWith("/me")
        ? Promise.resolve(new Response(JSON.stringify({ id: "u-sam", username: "sam" })))
        : inner!(input, init);

    return (await itsaplanKnowledge.doctor!(secrets, { ...ctx, fetch })).find(
      (c) => c.name === "Its a Plan document links",
    );
  };

  it("says what linking needs once the key reads the links of a document", async () => {
    const { fake } = await setup();
    expect(await checkOf(derive(fake.fetch))).toEqual({
      name: "Its a Plan document links",
      status: "ok",
      detail:
        "The key reads which tickets a document is linked on; linking one needs documents: edit and work items: edit.",
    });

    expect(await checkOf(derive(fake.fetch, "office"))).toBeUndefined();
  });

  it("is not checked before the project has a document, and warns when the key is refused", async () => {
    const empty = createItsaplanFake();
    expect(await checkOf(derive(empty.fetch))).toMatchObject({
      status: "warn",
      detail:
        "Not checked: the project has no document yet. Linking one on a ticket needs documents: edit and work items: edit.",
    });

    const { fake } = await setup();
    const answering =
      (status: number): typeof fetch =>
      (input, init) =>
        String(input).endsWith("/issues")
          ? Promise.resolve(new Response(JSON.stringify({ error: "no" }), { status }))
          : fake.fetch(input, init);

    expect(await checkOf(derive(answering(403)))).toMatchObject({
      status: "warn",
      detail:
        "The key may not read the links between documents and tickets, so the agent's documents are not linked on their tickets.",
      fix: "Give the member documents: edit and work items: edit in the project, which linking a document on a ticket needs.",
    });

    expect(await checkOf(derive(answering(400)))).toMatchObject({
      status: "warn",
      detail: expect.stringMatching(/^Not checked: /),
    });
  });
});
