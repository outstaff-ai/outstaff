import { PortError, type RepoRef } from "@outstaff/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_LIMITS } from "#/pipeline/context/index.js";
import { openStore, type Store } from "#/store/index.js";
import type { PrRecord } from "#/workstate/index.js";
import { wakeContextOf } from "#/wake-context/index.js";
import { mergeContextOf, RECENT_MERGES } from "#/wake-context/merge.js";
import type { ContextReaders } from "#/wake-context/types.js";

const REPO = { host: "git.acme.example", owner: "acme", name: "app" };
const OTHER = { host: "git.acme.example", owner: "acme", name: "ops" };

const rec = (number: number, over: Partial<PrRecord> = {}): PrRecord => ({
  ref: { repo: REPO, number },
  title: `PR ${number}`,
  url: `https://git.acme.example/acme/app/pull/${number}`,
  headRef: `b${number}`,
  headSha: `sha${number}`,
  baseRef: "main",
  draft: false,
  state: "open",
  mergeable: "clean",
  author: { login: "acme-kofi[bot]", kind: "agent", person: "kofi" },
  checks: [],
  ci: "success",
  unresolvedThreads: 0,
  updatedAt: "2026-10-01T09:00:00.000Z",
  ...over,
});

const withoutUrl = ({ url: _url, ...r }: PrRecord): PrRecord => r;

describe("the context of a merge", () => {
  let store: Store;
  let prs: PrRecord[];
  let files: Record<number, string[]>;
  let baseChecks: Awaited<ReturnType<NonNullable<ContextReaders["vcs"]>["checks"]>> | Error;

  const vcs: NonNullable<ContextReaders["vcs"]> = {
    reviewThreads: async () => [],
    links: { thread: () => "", pr: () => "", commit: () => "" },
    changedFiles: async (_repo, number) => {
      const f = files[number];
      if (f === undefined) {
        throw new PortError("not_found", "gone");
      }

      return f;
    },
    checks: async () => {
      if (baseChecks instanceof Error) {
        throw baseChecks;
      }

      return baseChecks;
    },
  };

  const readers = (): ContextReaders => ({
    store,
    vcs,
    prs: (repo: RepoRef) => prs.filter((p) => p.ref.repo.name === repo.name),
  });

  beforeEach(async () => {
    store = await openStore("sqlite::memory:");
    files = {};
    baseChecks = [];
    prs = [];
  });

  afterEach(async () => {
    await store.close();
  });

  const keep = async (...records: PrRecord[]) => {
    prs.push(...records);
    for (const r of records) {
      await store.upsertSubject("pr", `acme/${r.ref.repo.name}#${r.ref.number}`, r);
    }
  };

  it("names the pull request's state, the base's checks, the related open pull requests first, and the latest merges", async () => {
    await keep(
      rec(10, {
        headRef: "feat/a",
        baseRef: "main",
        verdicts: [
          { actor: "ada-admin", kind: "human", state: "approved" },
          { actor: "grace-lead", kind: "human", state: "changes_requested" },
        ],
        checks: [
          { name: "lint", status: "failure" },
          { name: "test", status: "success" },
        ],
        ci: "failure",
        unresolvedThreads: 1,
      }),
      rec(11, {
        baseRef: "feat/a",
        updatedAt: "2026-10-01T10:00:00.000Z",
        verdicts: [{ actor: "ada-admin", kind: "human", state: "approved" }],
      }),
      rec(12, { headRef: "main", baseRef: "dev", updatedAt: "2026-10-01T11:00:00.000Z" }),
      rec(13, {
        author: { login: "grace-lead", kind: "human" },
        draft: true,
        updatedAt: "2026-10-01T12:00:00.000Z",
      }),
      rec(14, { baseRef: "release", updatedAt: "2026-10-01T13:00:00.000Z" }),
      rec(15, { baseRef: "release", updatedAt: "2026-10-01T14:00:00.000Z" }),
      withoutUrl(rec(16, { updatedAt: "2026-10-01T08:00:00.000Z" })),
      rec(20, { state: "merged", updatedAt: "2026-09-30T09:00:00.000Z" }),
      withoutUrl(
        rec(21, {
          state: "merged",
          updatedAt: "2026-09-30T10:00:00.000Z",
          author: { login: "grace-lead", kind: "human" },
        }),
      ),
      rec(22, { state: "merged", baseRef: "dev" }),
      rec(23, { state: "closed" }),
    );

    files = {
      10: ["src/cart.ts", "src/a.ts", "README.md"],
      13: ["src/cart.ts", "README.md", "docs/x.md"],
      14: ["other.ts"],
    };

    baseChecks = [
      { name: "build", status: "failure", url: "https://ci/build" },
      { name: "deploy", status: "failure", url: "" },
      { name: "lint", status: "success", url: "https://ci/lint" },
    ];

    const m = (await mergeContextOf(readers(), "acme/app#10", 4))!;
    expect(m.pr).toEqual({
      ref: "acme/app#10",
      number: 10,
      title: "PR 10",
      url: "https://git.acme.example/acme/app/pull/10",
      head: "feat/a",
      base: "main",
      draft: false,
      approvedBy: ["ada-admin"],
      changesRequestedBy: ["grace-lead"],
      ci: "failure",
      failing: [{ name: "lint" }],
      mergeable: "clean",
      unresolvedThreads: 1,
    });

    expect(m.base).toEqual({
      ref: "main",
      ci: "failure",
      failing: [{ name: "build", url: "https://ci/build" }, { name: "deploy" }],
    });

    expect(m.others.map((o) => [o.ref, o.relation, o.files])).toEqual([
      ["acme/app#12", ["under_it"], []],
      ["acme/app#11", ["stacked_on_it"], []],
      ["acme/app#13", ["same_base", "overlapping_files"], ["README.md", "src/cart.ts"]],
      ["acme/app#16", ["same_base"], []],
    ]);

    expect(m.others[3]).not.toHaveProperty("url");

    expect(m.others[1]).toMatchObject({ author: "kofi", approved: true, draft: false });
    expect(m.others[2]).toMatchObject({ author: "grace-lead", approved: false, draft: true });
    expect(m.moreOthers).toBe(2);
    expect(m.recentMerges).toEqual([
      {
        ref: "acme/app#21",
        number: 21,
        title: "PR 21",
        author: "grace-lead",
        at: "2026-09-30T10:00:00.000Z",
      },
      {
        ref: "acme/app#20",
        number: 20,
        title: "PR 20",
        url: "https://git.acme.example/acme/app/pull/20",
        author: "kofi",
        at: "2026-09-30T09:00:00.000Z",
      },
    ]);
  });

  it("keeps the latest merges and the related pull requests bounded, and says when the base cannot be read", async () => {
    const merged = Array.from({ length: RECENT_MERGES + 2 }, (_, i) =>
      rec(30 + i, { state: "merged", updatedAt: `2026-09-2${i}T09:00:00.000Z` }),
    );

    await keep(rec(10), rec(11), ...merged);
    baseChecks = new Error("down");
    const m = (await mergeContextOf(readers(), "acme/app#10", 8))!;
    expect(m.base).toEqual({ ref: "main", ci: "unknown", failing: [] });
    expect(m.recentMerges.map((r) => r.number)).toEqual([36, 35, 34, 33, 32]);
    expect(m.others.map((o) => [o.ref, o.relation])).toEqual([["acme/app#11", ["same_base"]]]);
    expect(m).not.toHaveProperty("moreOthers");
  });

  it("is nothing for a pull request the office does not know, or without the work state", async () => {
    expect(await mergeContextOf(readers(), "acme/app#99", 8)).toBeUndefined();
    await keep(rec(10));
    expect(await mergeContextOf({ store }, "acme/app#10", 8)).toEqual(undefined);
  });

  it("without a code host, names no files and no base checks", async () => {
    await keep(withoutUrl(rec(10)), rec(11));
    const m = (await mergeContextOf({ store, prs: () => prs }, "acme/app#10", 8))!;
    expect(m.pr).not.toHaveProperty("url");
    expect(m.base.ci).toBe("unknown");
    expect(m.others[0]!.relation).toEqual(["same_base"]);
  });

  it("goes with a merge item's wake, and in the trace of the event that woke it", async () => {
    await keep(
      rec(10),
      rec(11, { ref: { repo: OTHER, number: 11 } }),
      rec(12, { baseRef: "b10" }),
      rec(20, { state: "merged" }),
    );

    const recorded: unknown[] = [];
    const traces = {
      get: async (id: string) =>
        id === "vcs:1"
          ? { event: { id } as never, policies: [], aggregation: [], decisions: [] }
          : undefined,
      record: async (t: unknown) => {
        recorded.push(t);
      },
    };

    const wakeOf = wakeContextOf(readers(), { limits: DEFAULT_CONTEXT_LIMITS, traces });
    const item = await store.enqueue({
      person: "kofi",
      kind: "merge",
      title: "merge",
      trigger: "human",
      subject: { type: "pr", ref: "acme/app#10" },
      source: "vcs:1",
    });

    const context = (await wakeOf(item, true))!;
    expect(context.merge?.pr.ref).toBe("acme/app#10");
    expect(context.merge?.others.map((o) => o.ref)).toEqual(["acme/app#12"]);
    expect(recorded).toMatchObject([
      {
        context: {
          [item.id]: {
            merge: {
              pr: "acme/app#10",
              base: { ref: "main", ci: "none" },
              others: [{ ref: "acme/app#12", relation: ["stacked_on_it"] }],
              moreOthers: 0,
              recentMerges: ["acme/app#20"],
            },
          },
        },
      },
    ]);

    const other = await store.enqueue({
      person: "kofi",
      kind: "rebase",
      title: "rebase",
      trigger: "human",
      subject: { type: "pr", ref: "acme/app#10" },
    });

    expect((await wakeOf(other, false))?.merge).toBeUndefined();
    const unknown = await store.enqueue({
      person: "kofi",
      kind: "merge",
      title: "merge",
      trigger: "human",
      subject: { type: "pr", ref: "acme/app#77" },
    });

    expect(await wakeOf(unknown, false)).toBeUndefined();
  });
});
