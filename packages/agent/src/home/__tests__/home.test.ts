import { linkSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cacheHome, createHomeSpace, dataHome, humanSize, measureFolders } from "#/home/index.js";
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

  it("measures a link as itself, not what it points at, and a file as its size", async () => {
    const home = homeDir();
    mkdirSync(join(home, "big"));
    writeFileSync(join(home, "big/blob"), "x".repeat(256 * 1024));
    symlinkSync(join(home, "big"), join(home, "link"));
    writeFileSync(join(home, "notes.txt"), "y".repeat(64 * 1024));

    const [link, file] = await measureFolders([
      { name: "link", path: join(home, "link") },
      { name: "notes", path: join(home, "notes.txt") },
    ]);

    expect(link!.bytes).toBeLessThan(256 * 1024);
    expect(file!.bytes).toBeGreaterThanOrEqual(64 * 1024);
  });

  it("finds the cache and data homes where XDG puts them", () => {
    expect(cacheHome("/home/sam", {})).toBe("/home/sam/.cache");
    expect(dataHome("/home/sam", {})).toBe("/home/sam/.local/share");
    expect(cacheHome("/home/sam", { XDG_CACHE_HOME: "/cache" })).toBe("/cache");
    expect(dataHome("/home/sam", { XDG_DATA_HOME: "/data" })).toBe("/data");
  });

  it("writes sizes the way a person reads them", () => {
    expect(humanSize(535 * MIB)).toBe("535 MiB");
    expect(humanSize(2.5 * GIB)).toBe("2.5 GiB");
  });
});

describe("what fills the home", () => {
  /** Sam's home: whatever tools happen to have left there, and the worktrees. */
  function samsHome(extra: string[] = []) {
    const home = homeDir();
    for (const dir of [
      ".cache/acme-cli",
      ".cache/pip",
      ".local/share/mise",
      ".local/share/pnpm",
      ".local/bin",
      ".npm",
      "work",
      "worktrees/shop/ACME-12",
      ...extra,
    ]) {
      mkdirSync(join(home, dir), { recursive: true });
    }

    writeFileSync(join(home, ".bashrc"), "");
    return home;
  }

  const SIZES: Record<string, number> = {
    "~/.local/share/pnpm": 625 * MIB,
    "~/.local/share/mise": 665 * MIB,
    "~/.cache/acme-cli": 552 * MIB,
    "~/.npm": 437 * MIB,
    "~/.cache/pip": 12 * MIB,
    "~/.local/bin": 3 * MIB,
    worktrees: 1.2 * GIB,
  };

  const space = (over: Partial<Parameters<typeof createHomeSpace>[0]> = {}) => {
    const measured: HomeFolder[][] = [];
    const home = over.home ?? samsHome();
    const homeSpace = createHomeSpace({
      home,
      env: {},
      worktreesDir: join(home, "worktrees"),
      held: () => ["ACME-12", "ACME-15", "ACME-20"],
      workStatus: async (ids) =>
        ids.map((workItemId, i) => ({ workItemId, state: i === 0 ? "active" : "blocked" })),
      measure: async (folders) => {
        measured.push(folders);
        return folders.map((f) => ({
          ...f,
          bytes: SIZES[f.name] ?? 0,
          capped: f.name === "~/.local/share/mise",
        }));
      },
      ...over,
    });

    return { home: homeSpace, measured };
  };

  it("names the five largest folders, largest first, with the worktrees' items", async () => {
    const { home, measured } = space();

    expect(await home.breakdown()).toBe(
      "Largest in the home: worktrees 1.2 GiB (3 items, 2 blocked or waiting), ~/.local/share/mise over 665 MiB, ~/.local/share/pnpm 625 MiB, ~/.cache/acme-cli 552 MiB, ~/.npm 437 MiB.",
    );

    // The cache and data homes are split into their entries and measured first; the worktrees last, so a store
    // hard-linked into them counts in the store. A folder that holds them is not measured as well.
    const names = measured[0]!.map((f) => f.name);
    expect(names.slice(0, 4).toSorted()).toEqual([
      "~/.cache/acme-cli",
      "~/.cache/pip",
      "~/.local/share/mise",
      "~/.local/share/pnpm",
    ]);

    expect(names.at(-1)).toBe("worktrees");
    expect(names).toEqual(
      expect.arrayContaining(["~/.local/bin", "~/.npm", "~/work", "~/.bashrc"]),
    );

    expect(names).not.toContain("~/.cache");
    expect(names).not.toContain("~/.local");
  });

  it("follows XDG overrides, inside the home or out of it", async () => {
    const home = samsHome(["xdg/data/acme"]);
    const elsewhere = homeDir();
    mkdirSync(join(elsewhere, "pnpm"));
    const { home: s, measured } = space({
      home,
      env: { XDG_CACHE_HOME: elsewhere, XDG_DATA_HOME: join(home, "xdg/data") },
    });

    await s.breakdown();

    const names = measured[0]!.map((f) => f.name);
    expect(names.slice(0, 2).toSorted()).toEqual([join(elsewhere, "pnpm"), "~/xdg/data/acme"]);
    expect(names).toEqual(expect.arrayContaining(["~/.cache", "~/.local"]));
    expect(names).not.toContain("~/xdg");
  });

  it("counts the items alone when the office cannot say their state", async () => {
    const { home } = space({ workStatus: () => Promise.reject(new Error("offline")) });

    expect(await home.breakdown()).toContain("worktrees 1.2 GiB (3 items),");
  });

  it("gives no counts without items, and nothing when every folder is empty", async () => {
    expect(await space({ held: () => [] }).home.breakdown()).toContain("worktrees 1.2 GiB, ");

    const empty = createHomeSpace({
      home: homeDir(),
      env: {},
      worktreesDir: "/nowhere/worktrees",
      held: () => [],
      workStatus: async () => [],
    });

    expect(await empty.folders()).toEqual([]);
    expect(await empty.breakdown()).toBeUndefined();
  });
});
