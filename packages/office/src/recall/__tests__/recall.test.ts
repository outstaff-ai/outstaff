import type { Logger, PrRef, WorkflowEvent } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import { teamConfig } from "#/intake/__tests__/test-support.js";
import { createRecall } from "#/recall/index.js";
import { openStore } from "#/store/index.js";
import type { Store } from "#/store/types.js";
import type { PrRecord } from "#/workstate/index.js";

const REPO = { host: "git.acme.example", owner: "acme", name: "app" };
const PR_URL = "https://git.acme.example/acme/app/pull/12";
const prSubject = (pr: PrRef) => `${pr.repo.host}/${pr.repo.owner}/${pr.repo.name}#${pr.number}`;

const team = teamConfig({
  humans: [
    {
      name: "Ada Admin",
      identities: { vcs: "ada-admin", tracker: "ada.admin", chat: "U0ADA00001" },
    },
  ],
});

function logger() {
  const warned: string[] = [];
  const log = { debug() {}, info() {}, error() {}, warn: (m: string) => warned.push(m) } as Logger;
  return { log, warned };
}

async function setup(store?: Store) {
  const s = store ?? (await openStore("sqlite::memory:"));
  const { log, warned } = logger();
  const workState = {
    pullRequests: (n: number) =>
      n === 12 ? [{ ref: { repo: REPO, number: 12 } } as PrRecord] : [],
    prSubject,
  };

  const recall = createRecall({
    store: s,
    team,
    workState,
    clock: manualClock("2026-10-02T00:00:00.000Z"),
    log,
    tracker: { links: { issue: (key) => `https://tracker.acme.example/issue/${key}` } },
  });

  return { store: s, recall, warned };
}

const comment = (body: string, at: string, subject: WorkflowEvent["subject"]): WorkflowEvent => ({
  type: subject.pr ? "pr.comment" : "ticket.commented",
  subject,
  actor: { kind: "human", id: subject.pr ? "ada-admin" : "ada.admin" },
  data: { body, at, ...(subject.pr ? { url: `${PR_URL}#c1` } : {}) },
});

describe("recall", () => {
  it("finds an agent's work and what happened on it, with where, who, an excerpt and a link", async () => {
    const { store, recall } = await setup();
    await store.enqueue({
      person: "sam",
      kind: "assigned",
      title: "ACME-1 Landing page",
      trigger: "human",
      subject: { type: "ticket", ref: "ACME-1" },
      refs: [
        { type: "pr", ref: prSubject({ repo: REPO, number: 12 }), role: "created", source: "pr" },
      ],
    });

    await store.upsertSubject("pr", prSubject({ repo: REPO, number: 12 }), {
      title: "Greetings",
      url: PR_URL,
    });

    const at = "2026-10-01T10:00:00.000Z";
    await recall.record(
      comment("Shorter greetings, please.", at, { pr: { repo: REPO, number: 12 } }),
      {
        source: "vcs",
        externalId: "c1",
      },
    );

    await recall.record(
      comment("Greetings look fine.", "2026-10-01T11:00:00.000Z", { ticket: "ACME-1" }),
      {
        source: "tracker",
        externalId: "t1",
      },
    );

    const r = await recall.search("sam", { query: "greetings", limit: 2 });
    expect(r.more).toBe(false);
    expect((await recall.search("sam", { query: "greetings", limit: 1 })).more).toBe(true);
    expect(r.moments).toEqual([
      {
        at: "2026-10-01T11:00:00.000Z",
        kind: "ticket.commented",
        where: { type: "ticket", ref: "ACME-1", url: "https://tracker.acme.example/issue/ACME-1" },
        who: "Ada Admin",
        excerpt: "Greetings look fine.",
        url: "https://tracker.acme.example/issue/ACME-1",
      },
      {
        at,
        kind: "pr.comment",
        where: { type: "pr", ref: "git.acme.example/acme/app#12", title: "Greetings", url: PR_URL },
        who: "Ada Admin",
        excerpt: "Shorter greetings, please.",
        url: `${PR_URL}#c1`,
      },
    ]);

    // Another agent's work does not refer to them, so it sees none of it.
    expect((await recall.search("noor", { query: "greetings", limit: 5 })).moments).toEqual([]);
  });

  it("narrows to a person by name or id, and to a ticket, pull request or document", async () => {
    const { store, recall } = await setup();
    const item = await store.enqueue({
      person: "sam",
      kind: "assigned",
      title: "Greet visitors",
      trigger: "human",
      subject: { type: "ticket", ref: "ACME-1" },
      refs: [
        { type: "pr", ref: prSubject({ repo: REPO, number: 12 }), role: "created", source: "pr" },
      ],
    });

    await store.appendJournal(item.id, "sam", "Greeting copy agreed.");
    await recall.record(
      comment("Greetings?", "2026-10-01T10:00:00.000Z", { pr: { repo: REPO, number: 12 } }),
      {
        source: "vcs",
        externalId: "c1",
      },
    );

    const whoOf = async (request: { with?: string; about?: string }) =>
      (await recall.search("sam", { query: "greeting", limit: 10, ...request })).moments
        .map((m) => `${m.kind}:${m.who ?? "-"}`)
        .sort();

    expect(await whoOf({ with: "Ada" })).toEqual(["pr.comment:Ada Admin"]);
    expect(await whoOf({ with: "ada-admin" })).toEqual(["pr.comment:Ada Admin"]);
    expect(await whoOf({ with: "sam" })).toEqual(["journal:sam"]);
    const all = ["item:-", "journal:sam", "pr.comment:Ada Admin"];
    expect(await whoOf({ about: "acme-1" })).toEqual(all);
    expect(await whoOf({ about: "#12" })).toEqual(all);
    expect(await whoOf({ about: `${PR_URL}/` })).toHaveLength(3);
    expect(await whoOf({ about: "other/repo#12" })).toEqual([]);
    expect(await whoOf({ about: "12" })).toHaveLength(3);
    expect(await whoOf({ about: "design-doc" })).toEqual([]);
  });

  it("takes a --since date and refuses one that is not a date", async () => {
    const { store, recall } = await setup();
    await store.enqueue({ person: "sam", kind: "assigned", title: "Greet", trigger: "human" });
    expect(
      (await recall.search("sam", { query: "greet", since: "2000-01-01", limit: 5 })).moments,
    ).toHaveLength(1);

    expect(
      (await recall.search("sam", { query: "greet", since: "2999-01-01", limit: 5 })).moments,
    ).toEqual([]);

    await expect(recall.search("sam", { query: "greet", since: "soon", limit: 5 })).rejects.toThrow(
      /not a date/,
    );
  });

  it("catches up on the events recorded before, once, and logs what it cannot index", async () => {
    let now = new Date("2026-10-01T12:00:00.000Z");
    const { store, recall, warned } = await setup(
      await openStore("sqlite::memory:", { now: () => now }),
    );

    const payload = (body: string, at: string) => ({
      event: comment(body, at, { ticket: "ACME-1" }),
    });

    await store.enqueue({
      person: "sam",
      kind: "assigned",
      title: "Landing",
      trigger: "human",
      subject: { type: "ticket", ref: "ACME-1" },
    });

    await store.recordEvent({
      source: "tracker",
      externalId: "a",
      type: "t",
      payload: payload("Banner one", "2026-10-01T11:00:00.000Z"),
    });

    await store.recordEvent({
      source: "tracker",
      externalId: "b",
      type: "t",
      payload: { raw: {} },
    });

    const ci = {
      type: "pr.ci_failed",
      subject: {},
      actor: { kind: "automation", id: "ci" },
      data: {},
    };

    await store.recordEvent({ source: "vcs", externalId: "ci", type: "t", payload: { event: ci } });
    await recall.catchUp();
    now = new Date("2026-10-01T12:00:01.000Z");
    await store.recordEvent({
      source: "tracker",
      externalId: "c",
      type: "t",
      payload: payload("Banner two", "2026-10-01T10:00:00.000Z"),
    });

    await recall.catchUp();
    expect(
      (await recall.search("sam", { query: "banner", limit: 5 })).moments.map((m) => m.excerpt),
    ).toEqual(["Banner one", "Banner two"]);

    expect(await store.getCursor("recall", "events")).toBeDefined();
    await store.close();
    await recall.catchUp();
    await recall.record(comment("x", "2026-10-01T10:00:00.000Z", { ticket: "ACME-1" }), {
      source: "tracker",
      externalId: "d",
    });

    expect(warned).toEqual([
      "could not index earlier events for recall",
      "could not index an event for recall",
    ]);
  });
});
