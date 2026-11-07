import { linkSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cacheDirs, createHomeSpace, humanSize, measureFolders } from "#/home/index.js";
import type { HomeFolder } from "#/home/index.js";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

function homeDir() {
  return mkdtempSync(join(tmpdir(), "ost-home-"));
}

describe("measuring the home", () => {
  it("counts a file hard-linked into several folders once, in the first, and follows no link", async () => {
    const home = homeDir();
    const store = join(home, "store");
    const worktree = join(home, "worktrees/shop/ACME-12/node_modules");
    mkdirSync(store, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(store, "pkg.js"), "x".repeat(64 * 1024));
    linkSync(join(store, "pkg.js"), join(worktree, "pkg.js"));
    writeFileSync(join(worktree, "own.js"), "y".repeat(16 * 1024));
    symlinkSync(store, join(worktree, "store-link"));

    const [s, w, missing] = await measureFolders([
      { name: "store", path: store },
      { name: "worktrees", path: join(home, "worktrees") },
      { name: "none", path: join(home, "none") },
    ]);

    expect(s!.bytes).toBeGreaterThanOrEqual(64 * 1024);
    expect(w!.bytes).toBeGreaterThanOrEqual(16 * 1024);
    expect(w!.bytes).toBeLessThan(64 * 1024);
    expect(missing).toMatchObject({ bytes: 0, capped: false });
  });

  it("stops at its limit and says the folders it did not finish are larger", async () => {
    const home = homeDir();
    for (const n of [1, 2, 3]) {
      writeFileSync(join(home, `f${n}`), "z");
    }

    const [first, second] = await measureFolders(
      [
        { name: "a", path: home },
        { name: "b", path: home },
      ],
      1,
    );

    expect(first!.capped).toBe(false);
    expect(second).toMatchObject({ bytes: 0, capped: true });
  });

  it("finds each tool's folders where the tool puts them", () => {
    expect(cacheDirs("/home/sam", {})).toEqual({
      miseData: "/home/sam/.local/share/mise",
      miseCache: "/home/sam/.cache/mise",
      pnpmStore: "/home/sam/.local/share/pnpm",
      pnpmCache: "/home/sam/.cache/pnpm",
      npmCache: "/home/sam/.npm",
    });

    expect(
      cacheDirs("/home/sam", {
        MISE_DATA_DIR: "/opt/mise",
        MISE_CACHE_DIR: "/var/mise",
        XDG_DATA_HOME: "/data",
        XDG_CACHE_HOME: "/cache",
        npm_config_cache: "/npm",
      }),
    ).toEqual({
      miseData: "/opt/mise",
      miseCache: "/var/mise",
      pnpmStore: "/data/pnpm",
      pnpmCache: "/cache/pnpm",
      npmCache: "/npm",
    });
  });

  it("writes sizes the way a person reads them", () => {
    expect(humanSize(535 * MIB)).toBe("535 MiB");
    expect(humanSize(2.5 * GIB)).toBe("2.5 GiB");
  });
});

describe("what fills the home", () => {
  const SIZES: Record<string, number> = {
    "pnpm store": 625 * MIB,
    "mise tools": 665 * MIB,
    "mise cache": 552 * MIB,
    "npm cache": 437 * MIB,
    "pnpm cache": 0,
    worktrees: 1.2 * GIB,
  };

  const space = (over: Partial<Parameters<typeof createHomeSpace>[0]> = {}) => {
    const measured: HomeFolder[][] = [];
    const home = createHomeSpace({
      home: "/home/sam",
      env: {},
      worktreesDir: "/home/sam/worktrees",
      held: () => ["ACME-12", "ACME-15", "ACME-20"],
      workStatus: async (ids) =>
        ids.map((workItemId, i) => ({ workItemId, state: i === 0 ? "active" : "blocked" })),
      measure: async (folders) => {
        measured.push(folders);
        return folders.map((f) => ({
          ...f,
          bytes: SIZES[f.name]!,
          capped: f.name === "mise tools",
        }));
      },
      ...over,
    });

    return { home, measured };
  };

  it("names the largest folders, largest first, with the worktrees' items", async () => {
    const { home, measured } = space();

    expect(await home.breakdown()).toBe(
      "Largest in the home: worktrees 1.2 GiB (3 items, 2 blocked or waiting), mise tools over 665 MiB, pnpm store 625 MiB, mise cache 552 MiB, npm cache 437 MiB.",
    );

    // The store is measured before the worktrees that link into it.
    const names = measured[0]!.map((f) => f.name);
    expect(names.indexOf("pnpm store")).toBeLessThan(names.indexOf("worktrees"));
  });

  it("counts the items alone when the office cannot say their state", async () => {
    const { home } = space({ workStatus: () => Promise.reject(new Error("offline")) });

    expect(await home.breakdown()).toContain("worktrees 1.2 GiB (3 items),");
  });

  it("gives no counts without items, and nothing when every folder is empty", async () => {
    expect(await space({ held: () => [] }).home.breakdown()).toContain("worktrees 1.2 GiB, ");

    const empty = createHomeSpace({
      home: "/home/sam",
      env: {},
      worktreesDir: "/home/sam/worktrees",
      held: () => [],
      workStatus: async () => [],
      measure: async (folders) => folders.map((f) => ({ ...f, bytes: 0, capped: false })),
    });

    expect(await empty.breakdown()).toBeUndefined();
  });
});
