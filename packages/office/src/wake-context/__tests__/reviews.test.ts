import type { Issue, ReviewThread } from "@outstaff/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_LIMITS } from "#/pipeline/context/index.js";
import { openStore, type Store } from "#/store/index.js";
import type { PrRecord } from "#/workstate/index.js";
import { gatherGraph, wakeContextOf } from "#/wake-context/index.js";

const REPO = { host: "git.acme.example", owner: "acme", name: "app" };

const prRecord = (number: number, over: Partial<PrRecord> = {}): PrRecord => ({
  ref: { repo: REPO, number },
  title: `PR ${number}`,
  url: `https://git.acme.example/acme/app/pull/${number}`,
  headRef: `b${number}`,
  headSha: "sha",
  baseRef: "main",
  draft: false,
  state: "open",
  mergeable: "clean",
  author: { login: "acme-sam[bot]", kind: "agent", person: "sam" },
  checks: [],
  ci: "none",
  unresolvedThreads: 0,
  updatedAt: "2026-10-01T09:00:00.000Z",
  ...over,
});

const issue = (key: string, parent?: string): Issue => ({
  key,
  id: key,
  title: `Ticket ${key}`,
  body: "",
  status: { name: "Active", canonical: "active" },
  labels: [],
  url: `https://track.acme.example/${key}`,
  updatedAt: "2026-10-01T09:00:00.000Z",
  ...(parent ? { parent } : {}),
});

const comment = (
  author: string,
  kind: "human" | "agent" | "bot",
  at: string,
  body: string,
): ReviewThread["comments"][number] => ({
  id: `${author}-${at}`,
  author,
  kind,
  body,
  at,
  url: `https://git.acme.example/acme/app/pull/1#discussion_${at}`,
});

/** On the merged #84 of the parent: the decision, made in a thread since resolved, and threads not a human's. */
const merged: ReviewThread[] = [
  {
    id: "T1",
    resolved: true,
    path: "test/isolation.test.ts",
    line: 1,
    comments: [
      comment("dana", "human", "2026-10-01T10:00:00.000Z", "Let's remove the isolation test."),
      comment("sam", "agent", "2026-10-01T10:30:00.000Z", "Removed."),
    ],
  },
  {
    id: "T2",
    resolved: true,
    comments: [
      comment("sam", "agent", "2026-10-01T11:00:00.000Z", "Should this stay?"),
      comment("dana", "human", "2026-10-01T11:10:00.000Z", "Yes, keep it."),
    ],
  },
  {
    id: "T3",
    resolved: false,
    comments: [comment("acme-ci", "bot", "2026-10-01T12:00:00.000Z", "Coverage dropped.")],
  },
  { id: "T4", resolved: false, comments: [] },
];

/** On the open #87 of the ticket being worked on. */
const open: ReviewThread[] = [
  {
    id: "T5",
    resolved: false,
    path: "src/run.ts",
    line: 9,
    comments: [comment("dana", "human", "2026-10-02T09:00:00.000Z", "Name this better.")],
  },
];

describe("review comments in the wake context", () => {
  let store: Store;
  let reads: number[];
  const vcs = {
    reviewThreads: async (_repo: unknown, number: number) => {
      reads.push(number);
      return number === 84 ? merged : open;
    },
    links: {
      thread: (_r: unknown, n: number, id: string) => `https://git.acme.example/pull/${n}#${id}`,
      pr: () => "",
      commit: () => "",
    },
    checks: async () => [],
  };

  const tracker = {
    getIssue: async (key: string) => issue(key, key === "ACME-141" ? "ACME-53" : undefined),
    listComments: async () => [],
  };

  const implement = async (number: number, ticket: string, over: Partial<PrRecord> = {}) => {
    await store.upsertSubject("pr", `acme/app#${number}`, prRecord(number, { ticket, ...over }));
    await store.link(
      { type: "pr", ref: `acme/app#${number}` },
      { type: "ticket", ref: ticket },
      "implements",
    );
  };

  beforeEach(async () => {
    store = await openStore("sqlite::memory:");
    reads = [];
    await implement(84, "ACME-53", { state: "merged" });
    await implement(87, "ACME-141");
    await implement(90, "ACME-141", { state: "closed" });
    await implement(91, "ACME-141", { state: "merged", goneAt: "2026-10-01T09:00:00.000Z" });
  });

  afterEach(async () => {
    await store.close();
  });

  const work = () =>
    store.enqueue({
      person: "sam",
      kind: "review",
      title: "t",
      trigger: "human",
      refs: [{ type: "pr", ref: "acme/app#87", role: "subject", source: "office" }],
    });

  it("hands the ticket the review comments of its PRs and its parent's, resolved and merged ones included", async () => {
    const item = await work();
    const context = await wakeContextOf(
      { store, tracker, vcs },
      { limits: DEFAULT_CONTEXT_LIMITS },
    )(item, true);

    const ticket = context!.tickets.find((t) => t.key === "ACME-141");
    expect(ticket?.reviews).toEqual([
      {
        pr: "acme/app#87",
        ticket: "ACME-141",
        resolved: false,
        path: "src/run.ts",
        line: 9,
        url: "https://git.acme.example/acme/app/pull/1#discussion_2026-10-02T09:00:00.000Z",
        author: "dana",
        at: "2026-10-02T09:00:00.000Z",
        body: "Name this better.",
      },
      expect.objectContaining({ pr: "acme/app#84", author: "dana", body: "Yes, keep it." }),
      expect.objectContaining({ pr: "acme/app#84", author: "sam", body: "Removed." }),
      expect.objectContaining({
        pr: "acme/app#84",
        ticket: "ACME-53",
        resolved: true,
        author: "dana",
        body: "Let's remove the isolation test.",
      }),
    ]);

    // The open PR's threads are read once for both lists; a closed or gone PR is not read.
    expect(reads.toSorted()).toEqual([84, 87]);
    expect(context!.prs.find((p) => p.ref === "acme/app#87")?.threads).toHaveLength(1);
  });

  it("reads a finished PR's threads once, and again only after its record changes", async () => {
    const item = await work();
    await gatherGraph({ store, tracker, vcs }, item.id, 16);
    await gatherGraph({ store, tracker, vcs }, item.id, 16);
    expect(reads.filter((n) => n === 84)).toHaveLength(1);
    expect(reads.filter((n) => n === 87)).toHaveLength(2);

    await store.upsertSubject(
      "pr",
      "acme/app#84",
      prRecord(84, { ticket: "ACME-53", state: "merged", updatedAt: "2026-10-03T09:00:00.000Z" }),
    );

    await gatherGraph({ store, tracker, vcs }, item.id, 16);
    expect(reads.filter((n) => n === 84)).toHaveLength(2);
  });

  it("goes without what the code host cannot answer, and without the code host", async () => {
    const item = await work();
    const down = {
      ...vcs,
      reviewThreads: async () => {
        throw new Error("down");
      },
    };

    const graph = await gatherGraph({ store, tracker, vcs: down }, item.id, 16);
    expect(graph.tickets.find((t) => t.key === "ACME-141")?.reviews).toEqual([]);
    const blind = await gatherGraph({ store, tracker }, item.id, 16);
    expect(blind.tickets.find((t) => t.key === "ACME-141")?.reviews).toEqual([]);
  });
});
