import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_LIMITS } from "#/pipeline/context/index.js";
import { openStore, type Store } from "#/store/index.js";
import { wakeContextOf } from "#/wake-context/index.js";
import type { PrRecord } from "#/workstate/index.js";

const REPO = { host: "git.acme.example", owner: "acme", name: "app" };
const key = (n: number) => `git.acme.example/acme/app#${n}`;
const SAM = { login: "acme-sam[bot]", kind: "agent" as const, person: "sam" };
const KOFI = { login: "acme-kofi[bot]", kind: "agent" as const, person: "kofi" };

const pr = (number: number, extra: Partial<PrRecord> = {}): PrRecord => ({
  ref: { repo: REPO, number },
  title: `PR ${number}`,
  url: `https://git.acme.example/acme/app/pull/${number}`,
  headRef: `b${number}`,
  headSha: "sha",
  baseRef: "main",
  draft: false,
  state: "open",
  mergeable: "clean",
  author: SAM,
  checks: [],
  ci: "success",
  unresolvedThreads: 0,
  updatedAt: "2026-10-01T16:54:00.000Z",
  ...extra,
});

/** #86 merged at 16:52 and the deploy on its merge commit failed. */
const MERGED = pr(86, {
  title: "Add the deploy config",
  state: "merged",
  ticket: "ACME-107",
  mergeChecks: { since: "2026-10-01T16:52:00.000Z", state: "failed", failing: [] },
  updatedAt: "2026-10-01T16:52:30.000Z",
});

describe("a wake's view of the agent's own work", () => {
  let store: Store;
  let records: PrRecord[];

  beforeEach(async () => {
    store = await openStore("sqlite::memory:");
    records = [MERGED];
  });

  afterEach(async () => {
    await store.close();
  });

  const wakeOf = (withPrs = true) =>
    wakeContextOf(
      { store, ...(withPrs ? { prs: () => records } : {}) },
      { limits: DEFAULT_CONTEXT_LIMITS },
    );

  const roundOn = async (kind: string, ref: string, person = "sam") =>
    store.enqueue({
      person,
      kind,
      title: kind,
      trigger: "automation",
      subject: { type: "pr", ref },
    });

  describe("in a chat session", () => {
    it("lists the agent's running and queued rounds with their kind and subject, running first, in queue order", async () => {
      for (const rec of records) {
        await store.upsertSubject("pr", key(rec.ref.number), rec);
      }

      await store.upsertSubject("ticket", "ACME-107", {
        key: "ACME-107",
        title: "Deploy the greeting",
        status: "review",
        labels: [],
        updatedAt: "t",
      });

      const fix = await roundOn("merge_checks_failed", key(86));
      const later = await store.enqueue({
        person: "sam",
        kind: "assigned",
        title: "assigned: ACME-110 Tidy the notes",
        trigger: "human",
        subject: { type: "ticket", ref: "ACME-110" },
        priority: 200,
      });

      const running = await store.enqueue({
        person: "sam",
        kind: "assigned",
        title: "assigned: ACME-109 Add the banner",
        trigger: "human",
        subject: { type: "ticket", ref: "ACME-109" },
      });

      await store.updateItem(running.id, { status: "active" });
      const finished = await roundOn("ci_failed", key(80));
      await store.updateItem(finished.id, { status: "done" });
      await roundOn("rebase", key(81), "kofi");
      await store.enqueue({
        person: "sam",
        kind: "chat",
        title: "Chat: earlier",
        trigger: "human",
      });

      const chat = await store.enqueue({
        person: "sam",
        kind: "chat",
        title: "Chat: why does the deploy still fail?",
        trigger: "human",
      });

      const context = (await wakeOf()(chat, false))!;
      expect(context.work).toEqual([
        {
          id: running.id,
          title: "assigned: ACME-109 Add the banner",
          status: "active",
          kind: "assigned",
          ticketKey: "ACME-109",
        },
        {
          id: fix.id,
          title: "merge_checks_failed",
          status: "queued",
          kind: "merge_checks_failed",
          ticketKey: "ACME-107",
          ticketTitle: "Deploy the greeting",
          pr: key(86),
          prNumber: 86,
          prTitle: "Add the deploy config",
          prUrl: "https://git.acme.example/acme/app/pull/86",
        },
        {
          id: later.id,
          title: "assigned: ACME-110 Tidy the notes",
          status: "queued",
          kind: "assigned",
          ticketKey: "ACME-110",
        },
      ]);

      // A round's own wake does not list the agent's work.
      expect((await wakeOf()(fix, false))?.work).toBeUndefined();
    });

    it("carries nothing when the agent has no other work", async () => {
      const chat = await store.enqueue({
        person: "sam",
        kind: "chat",
        title: "c",
        trigger: "human",
      });

      expect(await wakeOf()(chat, false)).toBeUndefined();
    });
  });

  describe("in a round on a failure", () => {
    it("lists the agent's pull requests in the repository since the merge whose checks failed, latest first", async () => {
      const unlinked = pr(88, {
        title: "Draft",
        draft: true,
        state: "merged",
        updatedAt: "2026-10-01T16:53:00.000Z",
      });

      delete unlinked.url;
      records.push(
        pr(87, { title: "Set the deploy region", ticket: "ACME-108" }),
        unlinked,
        pr(70, { title: "Before the merge", updatedAt: "2026-10-01T16:00:00.000Z" }),
        pr(71, { title: "Closed", state: "closed" }),
        pr(72, { title: "Gone", goneAt: "2026-10-01T16:55:00.000Z" }),
        pr(73, { title: "Someone else's", author: KOFI }),
      );

      await store.upsertSubject("pr", key(86), MERGED);
      const round = await roundOn("merge_checks_failed", key(86));
      expect((await wakeOf()(round, false))!.recentPrs).toEqual([
        {
          ref: key(87),
          number: 87,
          title: "Set the deploy region",
          url: "https://git.acme.example/acme/app/pull/87",
          state: "open",
          draft: false,
          ticket: "ACME-108",
          at: "2026-10-01T16:54:00.000Z",
        },
        {
          ref: key(88),
          number: 88,
          title: "Draft",
          state: "merged",
          draft: true,
          at: "2026-10-01T16:53:00.000Z",
        },
      ]);
    });

    it("counts from when the round was queued for failing checks or a conflict", async () => {
      const failing = pr(90, { title: "Failing", ci: "failure" });
      const later = new Date(Date.now() + 60_000).toISOString();
      records.push(failing, pr(91, { title: "Pushed since", updatedAt: later }));
      await store.upsertSubject("pr", key(90), failing);
      for (const kind of ["ci_failed", "rebase"]) {
        const round = await roundOn(kind, key(90));
        expect((await wakeOf()(round, false))!.recentPrs?.map((p) => p.number)).toEqual([91]);
      }
    });

    it("lists nothing for other rounds, an unknown pull request, or without the work state", async () => {
      records.push(pr(87));
      await store.upsertSubject("pr", key(86), MERGED);
      const merge = await roundOn("merge", key(86));
      expect((await wakeOf()(merge, false))?.recentPrs).toBeUndefined();

      const unknown = await roundOn("ci_failed", key(99));
      expect((await wakeOf()(unknown, false))?.recentPrs).toBeUndefined();

      const round = await roundOn("merge_checks_failed", key(86));
      expect((await wakeOf(false)(round, false))?.recentPrs).toBeUndefined();

      const ticketRound = await store.enqueue({
        person: "sam",
        kind: "ci_failed",
        title: "t",
        trigger: "automation",
        subject: { type: "ticket", ref: "ACME-107" },
      });

      expect((await wakeOf()(ticketRound, false))?.recentPrs).toBeUndefined();
    });
  });
});
