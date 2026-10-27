import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@outstaff/core";
import type { WorkState } from "@outstaff/protocol";
import { describe, expect, it, vi } from "vitest";
import { createManualClock } from "#/office-client/testing.js";
import type { Offer } from "#/office-client/index.js";
import { createWorkspaces } from "#/repos/workspaces.js";
import type { ClonedRepo } from "#/repos/index.js";
import { createSweeper } from "#/sweep/sweeper.js";

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const DAY = 24 * 60 * 60 * 1000;

const offer = (id: string): Offer =>
  ({
    workItem: { id, kind: "ticket", title: `Work on ${id}`, priority: 1, trigger: "human" },
    context: { journal: [], subjects: [], links: [] },
  }) as Offer;

/** Marcus's clone of one repository, with an origin to fetch from. */
function marcus() {
  const dir = mkdtempSync(join(tmpdir(), "ost-sweep-"));
  const origin = join(dir, "origin");
  mkdirSync(origin);
  sh(origin, "init", "-q", "-b", "main");
  sh(origin, "config", "user.name", "Seed");
  sh(origin, "config", "user.email", "seed@acme.example");
  writeFileSync(join(origin, "README.md"), "# shop\n");
  sh(origin, "add", ".");
  sh(origin, "commit", "-q", "-m", "init");

  const clone = join(dir, "home/repos/shop");
  sh(dir, "clone", "-q", origin, clone);
  sh(clone, "config", "user.name", "Marcus");
  sh(clone, "config", "user.email", "marcus@acme.example");

  const layout = {
    worktreesDir: join(dir, "home/worktrees"),
    scratchDir: join(dir, "home/scratch"),
  };

  const repo: ClonedRepo = {
    name: "shop",
    dir: clone,
    ref: { host: "github.com", owner: "acme-example", name: "shop" },
    defaultBranch: "main",
    access: "write",
    kind: "primary",
    instructions: [],
    trackerLabels: [],
  };

  const workspaces = createWorkspaces({ layout, repos: [repo] });

  return { clone, layout, workspaces };
}

/** The office as Marcus's agent sees it: the state of each item, and the journal it can write to. */
function fakeOffice(states: Record<string, WorkState["state"]>) {
  const asked: string[][] = [];
  const journal: { id: string; text: string }[] = [];
  const office = {
    workStatus: vi.fn<(ids: string[]) => Promise<WorkState[]>>(async (ids) => {
      asked.push(ids);

      return ids.map((workItemId) => ({ workItemId, state: states[workItemId] ?? "unknown" }));
    }),
    journal: vi.fn<(id: string, text: string) => Promise<void>>(async (id, text) => {
      journal.push({ id, text });
    }),
  };

  return { office, asked, journal, states };
}

function capturingLog() {
  const log = {
    debug: vi.fn<Logger["debug"]>(),
    info: vi.fn<Logger["info"]>(),
    warn: vi.fn<Logger["warn"]>(),
    error: vi.fn<Logger["error"]>(),
  } satisfies Logger;

  return log;
}

const worktreesOf = (clone: string) =>
  sh(clone, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length))
    .filter((p) => p.includes("/worktrees/"))
    .map((p) => p.split("/").at(-1))
    .toSorted();

/** Lets a sweep that has begun finish and schedule the next one. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

const ITEMS = ["ACME-12", "ACME-15", "ACME-18", "ACME-20", "ACME-22"];
const STATES: Record<string, WorkState["state"]> = {
  "ACME-12": "done",
  "ACME-15": "canceled",
  "ACME-18": "not_yours",
  "ACME-20": "blocked",
  "ACME-22": "queued",
};

describe("sweeper", () => {
  async function restarted() {
    const m = marcus();
    for (const id of ITEMS) {
      await m.workspaces.prepare(offer(id));
    }

    // Unpushed work on a canceled item: the branch has to outlive its worktree.
    const worktree = join(m.layout.worktreesDir, "shop/ACME-15");
    sh(worktree, "switch", "-q", "-c", "marcus/acme-15");
    writeFileSync(join(worktree, "wip.txt"), "unpushed\n");
    sh(worktree, "add", ".");
    sh(worktree, "commit", "-q", "-m", "wip");

    const fake = fakeOffice({ ...STATES });
    const log = capturingLog();
    const clock = createManualClock();
    const sweeper = createSweeper({
      office: fake.office,
      workspaces: m.workspaces,
      clock,
      log,
    });

    return { ...m, ...fake, log, clock, sweeper };
  }

  it("removes the worktrees and scratch of finished, canceled and reassigned items only", async () => {
    const t = await restarted();
    expect(worktreesOf(t.clone)).toEqual(ITEMS);

    const removed = await t.sweeper.sweep();

    expect(t.asked).toEqual([expect.arrayContaining(ITEMS)]);
    expect(removed.toSorted()).toEqual(["ACME-12", "ACME-15", "ACME-18"]);
    expect(worktreesOf(t.clone)).toEqual(["ACME-20", "ACME-22"]);
    expect(t.workspaces.held().toSorted()).toEqual(["ACME-20", "ACME-22"]);
    for (const id of ["ACME-12", "ACME-15", "ACME-18"]) {
      expect(existsSync(join(t.layout.scratchDir, id))).toBe(false);
    }

    for (const id of ["ACME-20", "ACME-22"]) {
      expect(existsSync(join(t.layout.scratchDir, id))).toBe(true);
    }

    // The branch of the canceled item keeps its unpushed commit.
    expect(sh(t.clone, "log", "--format=%s", "marcus/acme-15")).toContain("wip");
    // Nothing is left registered for the removed worktrees.
    expect(sh(t.clone, "worktree", "list")).not.toContain("ACME-12");
  });

  it("writes each removal to the log, and to the journal of items that are still his", async () => {
    const t = await restarted();
    await t.sweeper.sweep();

    const logged = t.log.info.mock.calls.map(([, data]) => data);
    expect(logged).toEqual(
      expect.arrayContaining([
        { workItemId: "ACME-12", state: "done" },
        { workItemId: "ACME-15", state: "canceled" },
        { workItemId: "ACME-18", state: "not_yours" },
      ]),
    );

    expect(t.journal.map((j) => j.id).toSorted()).toEqual(["ACME-12", "ACME-15"]);
    expect(t.journal[0]?.text).toContain("Removed the worktree and scratch folder");
  });

  it("logs a journal entry the office refuses and goes on", async () => {
    const t = await restarted();
    t.office.journal.mockRejectedValue(new Error("no such item"));

    expect(await t.sweeper.sweep()).toHaveLength(3);
    expect(t.log.warn).toHaveBeenCalledWith("could not journal a sweep", {
      workItemId: expect.any(String),
      error: "no such item",
    });
  });

  it("asks nothing when nothing is held", async () => {
    const m = marcus();
    const fake = fakeOffice({});
    const sweeper = createSweeper({
      office: fake.office,
      workspaces: m.workspaces,
      clock: createManualClock(),
      log: capturingLog(),
    });

    expect(await sweeper.sweep()).toEqual([]);
    expect(fake.office.workStatus).not.toHaveBeenCalled();
  });

  it("ignores an answer for an item that was not asked about", async () => {
    const m = marcus();
    await m.workspaces.prepare(offer("ACME-20"));
    const fake = fakeOffice({ "ACME-20": "blocked" });
    fake.office.workStatus.mockResolvedValue([
      { workItemId: "ACME-20", state: "blocked" },
      { workItemId: "ACME-99", state: "done" },
    ]);

    const release = vi.spyOn(m.workspaces, "release");
    const sweeper = createSweeper({
      office: fake.office,
      workspaces: m.workspaces,
      clock: createManualClock(),
      log: capturingLog(),
    });

    expect(await sweeper.sweep()).toEqual([]);
    expect(release).not.toHaveBeenCalled();
  });

  it("sweeps at start and then once a day, until stopped", async () => {
    const t = await restarted();
    t.sweeper.start();
    t.sweeper.start();
    await vi.waitFor(() => expect(worktreesOf(t.clone)).toEqual(["ACME-20", "ACME-22"]));
    await settled();
    expect(t.asked).toHaveLength(1);

    // ACME-20 is done while the agent is up; the next sweep is a day later.
    t.states["ACME-20"] = "done";
    t.clock.advance(DAY - 1);
    expect(t.asked).toHaveLength(1);

    t.clock.advance(1);
    await vi.waitFor(() => expect(worktreesOf(t.clone)).toEqual(["ACME-22"]));
    await settled();
    expect(t.asked).toHaveLength(2);

    t.sweeper.stop();
    t.states["ACME-22"] = "canceled";
    t.clock.advance(DAY);
    await Promise.resolve();
    expect(t.asked).toHaveLength(2);
    expect(worktreesOf(t.clone)).toEqual(["ACME-22"]);
  });

  it("logs a failed sweep and tries again at the next one", async () => {
    const t = await restarted();
    t.office.workStatus.mockRejectedValueOnce(new Error("Not connected to the office."));
    t.sweeper.start();
    await vi.waitFor(() =>
      expect(t.log.warn).toHaveBeenCalledWith("could not sweep the workspaces", {
        error: "Not connected to the office.",
      }),
    );

    expect(worktreesOf(t.clone)).toEqual(ITEMS);

    await settled();
    t.clock.advance(DAY);
    await vi.waitFor(() => expect(worktreesOf(t.clone)).toEqual(["ACME-20", "ACME-22"]));
    t.sweeper.stop();
  });

  it("sweeps on a schedule of its own when one is given", async () => {
    const m = marcus();
    await m.workspaces.prepare(offer("ACME-20"));
    const fake = fakeOffice({ "ACME-20": "blocked" });
    const clock = createManualClock();
    const sweeper = createSweeper({
      office: fake.office,
      workspaces: m.workspaces,
      clock,
      log: capturingLog(),
      everyMs: 1000,
    });

    sweeper.start();
    await vi.waitFor(() => expect(fake.asked).toHaveLength(1));
    await settled();
    clock.advance(1000);
    await vi.waitFor(() => expect(fake.asked).toHaveLength(2));
    sweeper.stop();
  });
});
