import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HomeFolder } from "#/home/index.js";
import type { MiseResult } from "#/tools/index.js";
import { createCachePruner } from "#/sweep/caches.js";
import { removeOlderThan } from "#/sweep/old-files.js";
import { capturingLog } from "./marcus.js";

const MIB = 1024 ** 2;
const NOW = Date.parse("2030-01-01T00:00:00.000Z");

/** Marcus's home, with the volume `share` full and the tools in `installed` on PATH. */
function pruner(share: number, installed = ["mise", "pnpm", "npm"]) {
  const home = mkdtempSync(join(tmpdir(), "ost-caches-"));
  const calls: string[] = [];

  // Each prune halves what its folder holds.
  const folderOf: Record<string, string> = {
    mise: join(home, ".cache/mise"),
    pnpm: join(home, ".local/share/pnpm"),
    npm: join(home, ".npm"),
  };

  const sizes: Record<string, number> = {
    [folderOf["mise"]!]: 500 * MIB,
    [folderOf["pnpm"]!]: 600 * MIB,
    [folderOf["npm"]!]: 400 * MIB,
  };

  const run = vi.fn(async (file: string, args: string[]): Promise<MiseResult> => {
    if (!installed.includes(file)) {
      return { code: 127, stdout: "", stderr: `${file} is not installed in this image.` };
    }

    calls.push([file, ...args].join(" "));
    if (args[0] !== "--version") {
      const dir = folderOf[file]!;
      sizes[dir] = sizes[dir]! / 2;
    }

    return { code: 0, stdout: "", stderr: "" };
  });

  const measure = async (folders: HomeFolder[]) =>
    folders.map((f) => ({ ...f, bytes: sizes[f.path] ?? 0, capped: false }));

  const log = capturingLog();
  const caches = createCachePruner({
    home,
    env: {},
    run,
    log,
    measure,
    now: () => NOW,
    volume: async () => ({ used: share * 100, total: 100 }),
  });

  return { home, calls, run, log, caches };
}

const commands = (calls: string[]) => calls.filter((c) => !c.endsWith("--version"));

describe("cache pruning", () => {
  it("clears mise's cache on every sweep, and leaves pnpm and npm while there is room", async () => {
    const t = pruner(0.5);

    expect(await t.caches.prune()).toEqual([{ cache: "mise", freed: 250 * MIB }]);
    expect(commands(t.calls)).toEqual(["mise cache clear"]);
    expect(t.log.info).toHaveBeenCalledWith("pruned the caches: 250 MiB reclaimed (mise 250 MiB)");
  });

  it("also prunes the pnpm store and old npm entries over the doctor's warning share", async () => {
    const t = pruner(0.8);
    const index = join(t.home, ".npm/_cacache/index-v5/ab/cd");
    mkdirSync(index, { recursive: true });
    const old = join(index, "old");
    const recent = join(index, "recent");
    writeFileSync(old, "{}\n");
    writeFileSync(recent, "{}\n");
    const days = (n: number) => (NOW - n * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(old, days(31), days(31));
    utimesSync(recent, days(29), days(29));

    const pruned = await t.caches.prune();

    expect(commands(t.calls)).toEqual(["mise cache clear", "pnpm store prune", "npm cache verify"]);
    expect(pruned.map((p) => p.cache)).toEqual(["mise", "pnpm", "npm"]);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(t.log.info).toHaveBeenCalledOnce();
    expect(t.log.info).toHaveBeenCalledWith(
      "pruned the caches: 750 MiB reclaimed (mise 250 MiB, pnpm 300 MiB, npm 200 MiB)",
    );
  });

  it("skips a tool that is not installed, quietly", async () => {
    const t = pruner(0.9, ["pnpm"]);

    expect((await t.caches.prune()).map((p) => p.cache)).toEqual(["pnpm"]);
    expect(t.log.warn).not.toHaveBeenCalled();
  });

  it("logs nothing when no tool is installed", async () => {
    const t = pruner(0.9, []);

    expect(await t.caches.prune()).toEqual([]);
    expect(t.log.info).not.toHaveBeenCalled();
  });

  it("warns about a step that fails and goes on", async () => {
    const t = pruner(0.9);
    t.run.mockImplementation(async (file, args) =>
      file === "pnpm" && args[0] === "store"
        ? { code: 1, stdout: "", stderr: "ERR_PNPM_STORE broken" }
        : { code: 0, stdout: "", stderr: "" },
    );

    expect((await t.caches.prune()).map((p) => p.cache)).toEqual(["mise", "pnpm", "npm"]);
    expect(t.log.warn).toHaveBeenCalledWith("could not prune a cache", {
      cache: "pnpm",
      error: "ERR_PNPM_STORE broken",
    });
  });

  it("leaves pnpm and npm when the volume cannot be read", async () => {
    const t = pruner(0.9);
    const caches = createCachePruner({
      home: t.home,
      env: {},
      run: t.run,
      measure: async (f) => f.map((x) => ({ ...x, bytes: 0, capped: false })),
      volume: () => Promise.reject(new Error("ENOENT")),
    });

    expect((await caches.prune()).map((p) => p.cache)).toEqual(["mise"]);
  });

  it("finds nothing old in a folder that does not exist", async () => {
    expect(await removeOlderThan(join(tmpdir(), "ost-no-such-folder"), NOW)).toBe(0);
  });
});
