import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@outstaff/core";
import type { WorkState } from "@outstaff/protocol";
import { vi } from "vitest";
import type { Offer } from "#/office-client/index.js";
import { createWorkspaces } from "#/repos/workspaces.js";
import type { ClonedRepo } from "#/repos/index.js";

export const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export const DAY = 24 * 60 * 60 * 1000;

export const offer = (id: string): Offer =>
  ({
    workItem: { id, kind: "ticket", title: `Work on ${id}`, priority: 1, trigger: "human" },
    context: { journal: [], subjects: [], links: [] },
  }) as Offer;

/** Marcus's clone of one repository, with an origin to fetch from. */
export function marcus(now?: () => number) {
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

  const workspaces = createWorkspaces({ layout, repos: [repo], ...(now ? { now } : {}) });

  return { clone, origin, layout, workspaces };
}

/** The office as Marcus's agent sees it: the state of each item, when it last changed, and the journal it can write to. */
export function fakeOffice(
  states: Record<string, WorkState["state"]>,
  changed: Record<string, string> = {},
) {
  const asked: string[][] = [];
  const journal: { id: string; text: string }[] = [];
  const office = {
    workStatus: vi.fn<(ids: string[]) => Promise<WorkState[]>>(async (ids) => {
      asked.push(ids);

      return ids.map((workItemId) => ({
        workItemId,
        state: states[workItemId] ?? "unknown",
        ...(changed[workItemId] ? { updatedAt: changed[workItemId] } : {}),
      }));
    }),
    journal: vi.fn<(id: string, text: string) => Promise<void>>(async (id, text) => {
      journal.push({ id, text });
    }),
  };

  return { office, asked, journal, states };
}

export function capturingLog() {
  const log = {
    debug: vi.fn<Logger["debug"]>(),
    info: vi.fn<Logger["info"]>(),
    warn: vi.fn<Logger["warn"]>(),
    error: vi.fn<Logger["error"]>(),
  } satisfies Logger;

  return log;
}

export const worktreesOf = (clone: string) =>
  sh(clone, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length))
    .filter((p) => p.includes("/worktrees/"))
    .map((p) => p.split("/").at(-1))
    .toSorted();
