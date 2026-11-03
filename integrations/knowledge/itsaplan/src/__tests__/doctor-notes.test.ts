import { envSecretSource, type DeriveContext, type TeamConfig } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { API_KEY, team } from "@outstaff/testing.itsaplan";
import { createItsaplanFake } from "./fake.js";
import { itsaplanKnowledge, NOTES_ROOT } from "#/index.js";

const NAME = "Its a Plan agent notes";
const knowledgeTeam = { ...team, memory: { store: "knowledge" } } as TeamConfig;

const derive = (
  fetch: typeof globalThis.fetch,
  over: Partial<DeriveContext> = {},
): DeriveContext => ({
  team: knowledgeTeam,
  scope: "person",
  options: {},
  person: { handle: "sam", name: "Sam Duarte", identities: { tracker: "sam" } } as never,
  fetch,
  now: () => new Date("2026-01-01T00:00:00Z"),
  warn: () => {},
  ...over,
});

const secrets = envSecretSource({ ITSAPLAN_API_KEY: API_KEY }, "/nonexistent");

// The stand-in has no `/me`; the key's member is sam.
const checkOf = async ({ fetch: inner, ...ctx }: DeriveContext) => {
  const fetch: typeof globalThis.fetch = (input, init) =>
    String(input).endsWith("/me")
      ? Promise.resolve(new Response(JSON.stringify({ id: "u-sam", username: "sam" })))
      : inner(input, init);

  return (await itsaplanKnowledge.doctor!(secrets, { ...ctx, fetch })).find((c) => c.name === NAME);
};

describe("the agent notes check", () => {
  it("runs only for a person whose team keeps notes in the knowledge base", async () => {
    const fake = createItsaplanFake();
    expect(await checkOf(derive(fake.fetch, { scope: "office" }))).toBeUndefined();
    expect(await checkOf(derive(fake.fetch, { team }))).toBeUndefined();
    expect(await checkOf(derive(fake.fetch, { person: undefined } as never))).toBeUndefined();
  });

  it("says the first start creates the page, and finds it once there", async () => {
    const fake = createItsaplanFake();
    expect(await checkOf(derive(fake.fetch))).toMatchObject({
      status: "ok",
      detail: expect.stringContaining("the agent creates it on its first start"),
    });

    await fake.knowledgeSeed.notesEdit!("Sam Duarte", ["Ask first."], {
      name: "Sam",
      kind: "agent",
    });

    expect(await checkOf(derive(fake.fetch))).toEqual({
      name: NAME,
      status: "ok",
      detail: `The agent's notes are on ${NOTES_ROOT}/Sam Duarte.`,
    });

    // Private, and the key's own, so it still sees it.
    Object.assign(
      fake.state.docs.find((d) => d.title === "Sam Duarte")!,
      {
        isPrivate: true,
        ownerUserId: "u-sam",
      },
    );

    expect(await checkOf(derive(fake.fetch))).toMatchObject({
      status: "warn",
      fix: expect.any(String),
    });
  });

  it("fails when the key may not read the documents", async () => {
    const fake = createItsaplanFake();
    const answering =
      (status: number): typeof fetch =>
      (input, init) =>
        String(input).endsWith("/documents")
          ? Promise.resolve(new Response(JSON.stringify({ error: "no" }), { status }))
          : fake.fetch(input, init);

    expect(await checkOf(derive(answering(403)))).toMatchObject({
      status: "fail",
      detail:
        "The key may not read the project's documents, so the agent cannot keep its notes there.",
    });

    expect(await checkOf(derive(answering(400)))).toMatchObject({
      status: "fail",
      detail: expect.stringMatching(/^Not checked: /),
    });
  });
});
