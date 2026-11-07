import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkState } from "@outstaff/protocol";
import { describe, expect, it, vi } from "vitest";
import { createManualClock } from "#/office-client/__tests__/testing.js";
import { createSweeper } from "#/sweep/sweeper.js";
import { DAY, capturingLog, fakeOffice, marcus, offer, sh, worktreesOf } from "./marcus.js";

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
    // A sweep is over once it has scheduled the next one.
    const swept = t.clock.scheduled(DAY);
    t.sweeper.start();
    t.sweeper.start();
    await swept;
    expect(worktreesOf(t.clone)).toEqual(["ACME-20", "ACME-22"]);
    expect(t.asked).toHaveLength(1);

    // ACME-20 is done while the agent is up; the next sweep is a day later.
    t.states["ACME-20"] = "done";
    t.clock.advance(DAY - 1);
    expect(t.asked).toHaveLength(1);

    const again = t.clock.scheduled(DAY);
    t.clock.advance(1);
    await again;
    expect(worktreesOf(t.clone)).toEqual(["ACME-22"]);
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
    const failed = t.clock.scheduled(DAY);
    t.sweeper.start();
    await failed;
    expect(t.log.warn).toHaveBeenCalledWith("could not sweep the workspaces", {
      error: "Not connected to the office.",
    });

    expect(worktreesOf(t.clone)).toEqual(ITEMS);

    const swept = t.clock.scheduled(DAY);
    t.clock.advance(DAY);
    await swept;
    expect(worktreesOf(t.clone)).toEqual(["ACME-20", "ACME-22"]);
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

    const swept = clock.scheduled(1000);
    sweeper.start();
    await swept;
    expect(fake.asked).toHaveLength(1);

    const again = clock.scheduled(1000);
    clock.advance(1000);
    await again;
    expect(fake.asked).toHaveLength(2);
    sweeper.stop();
  });

  it("prunes the caches after every sweep, also when the office cannot be reached", async () => {
    const m = marcus();
    await m.workspaces.prepare(offer("ACME-12"));
    const fake = fakeOffice({ "ACME-12": "done" });
    const prune = vi.fn(async () => []);
    const log = capturingLog();
    const sweeper = createSweeper({
      office: fake.office,
      workspaces: m.workspaces,
      clock: createManualClock(),
      log,
      caches: { prune },
    });

    expect(await sweeper.sweep()).toEqual(["ACME-12"]);
    expect(prune).toHaveBeenCalledTimes(1);

    await m.workspaces.prepare(offer("ACME-15"));
    fake.office.workStatus.mockRejectedValueOnce(new Error("Not connected to the office."));
    await expect(sweeper.sweep()).rejects.toThrow("Not connected");
    expect(prune).toHaveBeenCalledTimes(2);

    prune.mockRejectedValueOnce(new Error("disk gone"));
    await sweeper.sweep();
    expect(log.warn).toHaveBeenCalledWith("could not prune the caches", { error: "disk gone" });
  });
});
