import { createFakeVcs } from "@outstaff/core/fakes";
import type { FakeVcs } from "@outstaff/core/fakes";
import { PortError, type RepoRef, type WorkflowEvent } from "@outstaff/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import type { ManualClock } from "#/types.js";
import { REPO, teamConfig } from "#/intake/__tests__/test-support.js";
import { openStore } from "#/store/open.js";
import type { Store } from "#/store/types.js";
import { createWorkState } from "#/workstate/workstate.js";
import type { WorkState } from "#/workstate/types.js";

const INFRA: RepoRef = { host: "git.acme.example", owner: "acme", name: "infra" };
const APP_REPO = { name: "app", url: "git.acme.example/acme/app", kind: "primary" };
const INFRA_REPO = { name: "infra", url: "git.acme.example/acme/infra", kind: "infra" };
const author = { login: "acme-sam[bot]", kind: "agent" } as const;

describe("pull requests the office can no longer read", () => {
  let clock: ManualClock;
  let store: Store;
  let vcs: FakeVcs;
  let ws: WorkState;
  let fetched: string[];
  let logs: { level: string; message: string; data?: Record<string, unknown> }[];

  /** `gone` makes the code host answer with that error code for a pull request; `fetched` lists every read. */
  const gone = new Map<string, "not_found" | "forbidden">();
  const logger = {
    debug() {},
    info: (message: string, data?: Record<string, unknown>) =>
      void logs.push({ level: "info", message, ...(data ? { data } : {}) }),
    warn: (message: string, data?: Record<string, unknown>) =>
      void logs.push({ level: "warn", message, ...(data ? { data } : {}) }),
    error() {},
  };

  const build = async (repos = [APP_REPO]) => {
    await ws?.stop();
    ws = await createWorkState({
      store,
      ports: { vcs },
      team: teamConfig({ repos }),
      clock,
      logger,
    });
  };

  const seed = (repo: RepoRef, head = "sam/work", base = "main") =>
    vcs.seed.pullRequest(repo, { author, title: "work", head: { ref: head }, base: { ref: base } });

  const comment = (number: number): WorkflowEvent => ({
    type: "pr.comment",
    subject: { pr: { repo: REPO, number } },
    actor: { kind: "human", id: "dana" },
    data: {},
  });

  const messages = (level: string) => logs.filter((l) => l.level === level).map((l) => l.message);

  beforeEach(async () => {
    clock = manualClock();
    store = await openStore("sqlite::memory:", { now: () => clock.now() });
    vcs = createFakeVcs({ now: clock.now });
    fetched = [];
    logs = [];
    gone.clear();
    const real = vcs.getPullRequest.bind(vcs);
    vcs.getPullRequest = async (repo, number, o) => {
      const key = `${repo.name}#${number}`;
      fetched.push(key);
      const code = gone.get(key);
      if (code) {
        throw new PortError(code, `${key}: ${code}`);
      }

      return real(repo, number, o);
    };

    await build();
  });

  afterEach(async () => {
    await ws.stop();
    await store.close();
  });

  const reads = (key: string) => fetched.filter((f) => f === key).length;

  it("drops the pull requests of a repository the team no longer lists, once, and never reads them", async () => {
    await build([APP_REPO, INFRA_REPO]);
    const base = await seed(INFRA, "sam/base");
    await seed(INFRA, "sam/top", "sam/base");
    const app = await seed(REPO);
    await ws.rescan();
    expect(ws.repoPrs(INFRA)).toHaveLength(2);
    expect(ws.stackedOn(INFRA, "sam/base")).toHaveLength(1);

    await build();
    fetched = [];
    await ws.rescan();
    await ws.rescan();
    await ws.rescan();
    expect(ws.repoPrs(INFRA)).toEqual([]);
    expect(fetched.filter((f) => f.startsWith("infra#"))).toEqual([]);
    expect(reads(`app#${app.number}`)).toBe(3);
    expect(messages("info")).toEqual([
      "dropped pull requests of repositories the team no longer lists",
    ]);

    const node = { type: "pr", ref: ws.prSubject({ repo: INFRA, number: base.number }) };
    expect(await store.queryLinks({ from: node })).toEqual([]);

    // Loaded again, nothing is left to drop.
    await build();
    expect(messages("info")).toHaveLength(1);
    expect(messages("warn")).toEqual([]);
  });

  it("ignores an event for a pull request outside the team's repositories", async () => {
    const other = await seed(INFRA);
    const event: WorkflowEvent = {
      type: "pr.opened",
      subject: { pr: { repo: INFRA, number: other.number } },
      actor: { kind: "human", id: "dana" },
      data: {},
    };

    await ws.apply(event, { source: "vcs", externalId: "e", trusted: true });
    expect(fetched).toEqual([]);
    expect(ws.repoPrs(INFRA)).toEqual([]);
  });

  it.each(["not_found", "forbidden"] as const)(
    "reads a pull request that answers %s once, says so once, and reads it again on an event",
    async (code) => {
      const lost = await seed(REPO, "sam/base");
      const top = await seed(REPO, "sam/top", "sam/base");
      const normal = await seed(REPO, "sam/other");
      await ws.rescan();
      const lostKey = ws.prSubject({ repo: REPO, number: lost.number });
      expect(ws.pullRequests(top.number)[0]?.stackedOn).toBe(lostKey);

      // The host stops listing it and answers with an error when it is read.
      gone.set(`app#${lost.number}`, code);
      const list = vcs.listPullRequests.bind(vcs);
      vcs.listPullRequests = async (repo, f) =>
        (await list(repo, f)).filter((p) => p.number !== lost.number);

      fetched = [];
      await ws.rescan();
      await ws.rescan();
      await ws.rescan();
      expect(reads(`app#${lost.number}`)).toBe(1);
      expect(reads(`app#${normal.number}`)).toBe(3);
      expect(messages("warn")).toEqual(["pull request gone, no longer refreshing it"]);
      expect(ws.currentWork("sam").prs.map((p) => p.ref)).not.toContain(lostKey);
      expect(ws.pullRequests(top.number)[0]?.stackedOn).toBeUndefined();
      expect(ws.pullRequests(lost.number)).toEqual([]);
      expect(ws.repoPrs(REPO).map((p) => p.ref.number)).not.toContain(lost.number);
      expect(ws.pullRequest({ repo: REPO, number: lost.number })).toBeUndefined();

      // An event names it while the host still refuses: it is read, and nothing more is said.
      await ws.apply(comment(lost.number), { source: "vcs", externalId: "e1", trusted: true });
      expect(reads(`app#${lost.number}`)).toBe(2);
      expect(messages("warn")).toHaveLength(1);

      // An event names it again and the host has it back: it is read and tracked again.
      gone.delete(`app#${lost.number}`);
      await ws.apply(comment(lost.number), { source: "vcs", externalId: "e2", trusted: true });
      expect(reads(`app#${lost.number}`)).toBe(3);
      expect(ws.pullRequests(lost.number)).toMatchObject([{ state: "open" }]);
      expect(ws.pullRequests(lost.number)[0]?.goneAt).toBeUndefined();
      expect(ws.pullRequests(top.number)[0]?.stackedOn).toBe(lostKey);
    },
  );

  it("reads a gone pull request again when the host lists it again", async () => {
    const lost = await seed(REPO);
    await ws.rescan();
    gone.set(`app#${lost.number}`, "forbidden");
    const list = vcs.listPullRequests.bind(vcs);
    vcs.listPullRequests = async (repo, f) =>
      (await list(repo, f)).filter((p) => p.number !== lost.number);

    await ws.rescan();
    expect(ws.pullRequests(lost.number)).toEqual([]);

    gone.delete(`app#${lost.number}`);
    vcs.listPullRequests = list;
    fetched = [];
    await ws.rescan();
    expect(reads(`app#${lost.number}`)).toBe(1);
    expect(ws.pullRequests(lost.number)).toMatchObject([{ state: "open" }]);
    expect(ws.pullRequests(lost.number)[0]?.goneAt).toBeUndefined();
    expect(ws.currentWork("sam").prs).toHaveLength(1);
  });

  it("forgets a gone pull request after the retention period", async () => {
    const lost = await seed(REPO);
    await ws.rescan();
    gone.set(`app#${lost.number}`, "not_found");
    const list = vcs.listPullRequests.bind(vcs);
    vcs.listPullRequests = async (repo, f) =>
      (await list(repo, f)).filter((p) => p.number !== lost.number);

    await ws.rescan();
    const node = { type: "pr", ref: ws.prSubject({ repo: REPO, number: lost.number }) };
    const tracked = () => store.queryLinks({ from: { type: "workstate", ref: "index" }, to: node });
    expect(await tracked()).toHaveLength(1);
    clock.advance(15 * 24 * 3_600_000);
    await ws.rescan();
    expect(await tracked()).toEqual([]);
  });

  it("only warns, without a record, for a pull request it never held", async () => {
    gone.set("app#99", "not_found");
    await ws.apply(comment(99), { source: "vcs", externalId: "e", trusted: true });

    expect(messages("warn")).toEqual(["pull request not found"]);
    expect(ws.pullRequests(99)).toEqual([]);
  });
});
