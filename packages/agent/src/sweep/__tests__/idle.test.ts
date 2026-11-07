import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkState } from "@outstaff/protocol";
import { describe, expect, it } from "vitest";
import { createManualClock } from "#/office-client/__tests__/testing.js";
import type { Offer } from "#/office-client/index.js";
import { createSweeper } from "#/sweep/sweeper.js";
import { DAY, capturingLog, fakeOffice, marcus, offer, sh, worktreesOf } from "./marcus.js";

type Setup = (worktree: string) => void;

const commit = (worktree: string, file: string) => {
  writeFileSync(join(worktree, file), `${file}\n`);
  sh(worktree, "add", ".");
  sh(worktree, "commit", "-q", "-m", file);
};

const pushedBranch =
  (branch: string): Setup =>
  (w) => {
    sh(w, "switch", "-q", "-c", branch);
    commit(w, `${branch.replaceAll("/", "-")}.txt`);
    sh(w, "push", "-q", "-u", "origin", branch);
  };

/** Each idle item's worktree, as the agent left it. */
const IDLE: Record<string, { state: WorkState["state"]; setup: Setup }> = {
  // Pushed, with dependencies installed: ignored files do not count.
  "ACME-30": {
    state: "blocked",
    setup: (w) => {
      pushedBranch("marcus/acme-30")(w);
      writeFileSync(join(w, ".gitignore"), "node_modules/\n");
      sh(w, "add", ".");
      sh(w, "commit", "-q", "-m", "ignore");
      sh(w, "push", "-q");
      mkdirSync(join(w, "node_modules/left-pad"), { recursive: true });
      writeFileSync(join(w, "node_modules/left-pad/index.js"), "module.exports = 1;\n");
    },
  },
  "ACME-31": {
    state: "blocked",
    setup: (w) => {
      pushedBranch("marcus/acme-31")(w);
      writeFileSync(join(w, "README.md"), "# changed\n");
    },
  },
  "ACME-32": {
    state: "waiting",
    setup: (w) => {
      pushedBranch("marcus/acme-32")(w);
      writeFileSync(join(w, "notes.txt"), "new\n");
    },
  },
  "ACME-33": {
    state: "blocked",
    setup: (w) => {
      pushedBranch("marcus/acme-33")(w);
      commit(w, "later.txt");
    },
  },
  "ACME-34": {
    state: "blocked",
    setup: (w) => {
      sh(w, "switch", "-q", "-c", "marcus/acme-34");
      commit(w, "local.txt");
    },
  },
  // New work never started: detached at the default branch, nothing beyond it.
  "ACME-35": { state: "blocked", setup: () => {} },
  "ACME-36": {
    state: "waiting",
    setup: (w) => commit(w, "detached.txt"),
  },
};

const SWEPT = ["ACME-30", "ACME-35"];
const KEPT = ["ACME-31", "ACME-32", "ACME-33", "ACME-34", "ACME-36"];

async function idleTeam(opts: { idleDays?: number; changedDaysAgo?: number } = {}) {
  const m = marcus();
  const clock = createManualClock();
  const states: Record<string, WorkState["state"]> = {};
  const changed: Record<string, string> = {};
  const at = new Date(clock.now().getTime() - (opts.changedDaysAgo ?? 8) * DAY).toISOString();
  for (const [id, { state, setup }] of Object.entries(IDLE)) {
    const ws = await m.workspaces.prepare(offer(id));
    setup(ws!.worktree);
    states[id] = state;
    changed[id] = at;
  }

  const fake = fakeOffice(states, changed);
  const log = capturingLog();
  const sweeper = createSweeper({
    office: fake.office,
    workspaces: m.workspaces,
    clock,
    log,
    ...(opts.idleDays === undefined ? {} : { idleDays: opts.idleDays }),
  });

  return { ...m, ...fake, clock, log, sweeper };
}

const keptReasons = (t: Awaited<ReturnType<typeof idleTeam>>) =>
  Object.fromEntries(
    t.log.info.mock.calls
      .filter(([msg]) => msg === "kept the workspace of an idle item")
      .map(([, data]) => [
        (data as { workItemId: string }).workItemId,
        (data as { reasons: string[] }).reasons,
      ]),
  );

describe("sweeping idle items", () => {
  it("removes an idle item's worktree only when nothing in it can be lost", async () => {
    const t = await idleTeam();

    expect((await t.sweeper.sweep()).toSorted()).toEqual(SWEPT);
    expect(worktreesOf(t.clone)).toEqual(KEPT);
    for (const id of SWEPT) {
      expect(existsSync(join(t.layout.scratchDir, id))).toBe(false);
    }

    for (const id of KEPT) {
      expect(existsSync(join(t.layout.scratchDir, id))).toBe(true);
    }

    // The branch outlives the worktree.
    expect(sh(t.clone, "branch", "--list", "marcus/acme-30")).toContain("marcus/acme-30");
  });

  it("logs why it keeps each worktree", async () => {
    const t = await idleTeam();
    await t.sweeper.sweep();

    expect(keptReasons(t)).toEqual({
      "ACME-31": ["shop: it has uncommitted changes"],
      "ACME-32": ["shop: it has untracked files"],
      "ACME-33": [
        "shop: branch marcus/acme-33 has 1 commit(s) not pushed to origin/marcus/acme-33",
      ],
      "ACME-34": ["shop: branch marcus/acme-34 has no upstream"],
      "ACME-36": ["shop: it has commits on no branch, beyond origin/main"],
    });
  });

  it("journals a removal, and why a worktree stays only once", async () => {
    const t = await idleTeam();
    await t.sweeper.sweep();
    await t.sweeper.sweep();

    const removed = t.journal.filter((j) => j.text.startsWith("Removed"));
    expect(removed.map((j) => j.id).toSorted()).toEqual(SWEPT);
    expect(removed[0]?.text).toContain("blocked for 7 days or more with no change");

    const kept = t.journal.filter((j) => j.text.startsWith("Kept"));
    expect(kept.map((j) => j.id).toSorted()).toEqual(KEPT);
    expect(kept.find((j) => j.id === "ACME-31")?.text).toContain(
      "because removing it could lose work: shop: it has uncommitted changes.",
    );

    // Both sweeps logged it.
    const logged = t.log.info.mock.calls.filter(
      ([m]) => m === "kept the workspace of an idle item",
    );
    expect(logged).toHaveLength(KEPT.length * 2);
  });

  it("keeps the workspace of an item that changed within idle_days", async () => {
    const t = await idleTeam({ changedDaysAgo: 6 });

    expect(await t.sweeper.sweep()).toEqual([]);
    expect(worktreesOf(t.clone)).toEqual([...SWEPT, ...KEPT].toSorted());
    expect(t.journal).toEqual([]);
  });

  it("keeps idle workspaces when idle_days is 0", async () => {
    const t = await idleTeam({ idleDays: 0, changedDaysAgo: 400 });

    expect(await t.sweeper.sweep()).toEqual([]);
    expect(worktreesOf(t.clone)).toHaveLength(Object.keys(IDLE).length);
  });

  it("keeps an idle item whose state has no time of change", async () => {
    const m = marcus();
    await m.workspaces.prepare(offer("ACME-35"));
    const fake = fakeOffice({ "ACME-35": "blocked" });
    const sweeper = createSweeper({
      office: fake.office,
      workspaces: m.workspaces,
      clock: createManualClock(),
      log: capturingLog(),
    });

    expect(await sweeper.sweep()).toEqual([]);
  });

  it("removes the clean worktree of a pull request's head branch, pushed by name", async () => {
    const m = marcus();
    const head = join(m.layout.worktreesDir, "..", "head");
    sh(m.clone, "worktree", "add", "-q", "-b", "marcus/acme-40", head);
    commit(head, "pr.txt");
    sh(head, "push", "-q", "origin", "marcus/acme-40");
    sh(m.clone, "worktree", "remove", "--force", head);
    sh(m.clone, "fetch", "-q");

    const pr = {
      ...offer("ACME-40"),
      workItem: {
        ...offer("ACME-40").workItem,
        kind: "review_feedback",
        subject: { type: "pr", ref: "shop#7" },
      },
      context: {
        journal: [],
        links: [],
        subjects: [
          { type: "pr", ref: "shop#7", own: true, state: "open", headRef: "marcus/acme-40" },
        ],
      },
    } as unknown as Offer;

    const ws = await m.workspaces.prepare(pr);
    expect(ws?.branch).toBe("marcus/acme-40");

    const clock = createManualClock();
    const fake = fakeOffice(
      { "ACME-40": "waiting" },
      { "ACME-40": new Date(clock.now().getTime() - 30 * DAY).toISOString() },
    );

    const sweeper = createSweeper({
      office: fake.office,
      workspaces: m.workspaces,
      clock,
      log: capturingLog(),
    });

    expect(await sweeper.sweep()).toEqual(["ACME-40"]);
  });

  it("leaves the workspace of an item a round prepared since the sweep began", async () => {
    const clock = createManualClock();
    const m = marcus(() => clock.now().getTime());
    await m.workspaces.prepare(offer("ACME-35"));

    expect(await m.workspaces.releaseIdle("ACME-35", clock.now().getTime())).toEqual({
      outcome: "in_use",
    });

    expect(worktreesOf(m.clone)).toEqual(["ACME-35"]);
    clock.advance(1);
    expect(await m.workspaces.releaseIdle("ACME-35", clock.now().getTime())).toEqual({
      outcome: "released",
    });
  });
});
