import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { VolumeUsage } from "#/doctor/types.js";
import { measureFolders, type HomeFolder } from "#/home/index.js";
import type { MiseResult, ProgramRunner } from "#/tools/index.js";
import { CACHE_RULES, createCachePruner } from "#/sweep/caches.js";
import { removeOlderThan } from "#/sweep/old-files.js";
import { capturingLog } from "./marcus.js";

const MIB = 1024 ** 2;
const NOW = Date.parse("2030-01-01T00:00:00.000Z");

const ago = (ms: number) => (NOW - ms) / 1000;

/** Files of one MiB each, written `ms` before now. */
function written(dir: string, ms: number, ...names: string[]) {
  mkdirSync(dir, { recursive: true });
  for (const name of names) {
    writeFileSync(join(dir, name), "x".repeat(MIB));
    utimesSync(join(dir, name), ago(ms), ago(ms));
  }

  return names.map((n) => join(dir, n));
}

/**
 * Marcus's home, with the volume `share` full, the tools in `installed` runnable and, with `mise`, two download
 * archives of mise: one written two hours ago, one a minute ago. The pnpm and npm folders are there.
 */
function pruner(share: number, installed = ["mise", "pnpm", "npm"], mise = true) {
  const home = mkdtempSync(join(tmpdir(), "ost-caches-"));
  const calls: string[] = [];
  const downloads = join(home, ".cache/mise/downloads-cas");
  const [oldArchive, newArchive] = mise
    ? [
        ...written(downloads, 2 * 60 * 60 * 1000, "old.tar.gz"),
        ...written(downloads, 60_000, "new.tar.gz"),
      ]
    : [];

  // Each prune halves what its folder holds.
  const folderOf: Record<string, string> = {
    pnpm: join(home, ".local/share/pnpm"),
    npm: join(home, ".npm"),
  };

  mkdirSync(folderOf["pnpm"]!, { recursive: true });
  mkdirSync(join(folderOf["npm"]!, "_cacache/index-v5"), { recursive: true });
  const sizes: Record<string, number> = {
    [folderOf["pnpm"]!]: 600 * MIB,
    [folderOf["npm"]!]: 400 * MIB,
  };

  const run = vi.fn<ProgramRunner>(async (file, args): Promise<MiseResult> => {
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
    sizes[folders[0]!.path] === undefined
      ? measureFolders(folders)
      : folders.map((f) => ({ ...f, bytes: sizes[f.path]!, capped: false }));

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

  return { home, calls, run, log, caches, oldArchive, newArchive };
}

const commands = (calls: string[]) => calls.filter((c) => !c.endsWith("--version"));

describe("cache pruning", () => {
  it("removes mise's older download archives on every sweep, and leaves pnpm and npm while there is room", async () => {
    const t = pruner(0.5);

    const pruned = await t.caches.prune();

    expect(pruned).toEqual([{ cache: "mise", freed: expect.any(Number) }]);
    expect(pruned[0]!.freed).toBeGreaterThanOrEqual(MIB);
    expect(existsSync(t.oldArchive!)).toBe(false);
    expect(existsSync(t.newArchive!)).toBe(true);
    expect(commands(t.calls)).toEqual([]);
    expect(t.log.info).toHaveBeenCalledWith(
      expect.stringMatching(/^pruned the caches: \d+ MiB reclaimed \(mise \d+ MiB\)$/),
    );
  });

  it("also prunes the pnpm store and old npm entries over the doctor's warning share", async () => {
    const t = pruner(0.8, ["mise", "pnpm", "npm"], false);
    const index = join(t.home, ".npm/_cacache/index-v5/ab/cd");
    const [old] = written(index, 31 * 24 * 60 * 60 * 1000, "old");
    const [recent] = written(index, 29 * 24 * 60 * 60 * 1000, "recent");

    const pruned = await t.caches.prune();

    expect(commands(t.calls)).toEqual(["pnpm store prune", "npm cache verify"]);
    expect(pruned.map((p) => p.cache)).toEqual(["pnpm", "npm"]);
    expect(existsSync(old!)).toBe(false);
    expect(existsSync(recent!)).toBe(true);
    expect(t.log.info).toHaveBeenCalledOnce();
    expect(t.log.info).toHaveBeenCalledWith(
      "pruned the caches: 500 MiB reclaimed (pnpm 300 MiB, npm 200 MiB)",
    );
  });

  it("skips a tool that is not installed, or whose shim resolves no version in the home, quietly", async () => {
    const t = pruner(0.9);
    t.run.mockImplementation(async (file) =>
      file === "pnpm"
        ? { code: 1, stdout: "", stderr: "mise ERROR No version is set for shim: pnpm" }
        : file === "npm"
          ? { code: 127, stdout: "", stderr: "npm is not installed in this image." }
          : { code: 0, stdout: "", stderr: "" },
    );

    expect((await t.caches.prune()).map((p) => p.cache)).toEqual(["mise"]);
    expect(t.run.mock.calls.filter(([, args]) => args[0] !== "--version")).toEqual([]);
    expect(t.log.warn).not.toHaveBeenCalled();
  });

  it("skips a rule whose folder does not exist without running its tool", async () => {
    const t = pruner(0.5, ["mise"], false);

    expect(await t.caches.prune()).toEqual([]);
    expect(t.run).not.toHaveBeenCalled();
  });

  it("logs nothing when no tool is installed", async () => {
    const t = pruner(0.9, [], false);

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

  it("runs a rule for every sweep without reading the volume, when no rule waits for a full one", async () => {
    const home = mkdtempSync(join(tmpdir(), "ost-caches-"));
    mkdirSync(join(home, ".acme"));
    const volume = vi.fn<(path: string) => Promise<VolumeUsage>>(async () => ({
      used: 99,
      total: 100,
    }));

    const run = vi.fn<ProgramRunner>(async () => ({ code: 0, stdout: "", stderr: "" }));
    const caches = createCachePruner({
      home,
      env: {},
      run,
      volume,
      rules: [
        {
          tool: "acme",
          folder: (h) => join(h, ".acme"),
          command: ["gc"],
          when: "every_sweep",
        },
      ],
    });

    expect(await caches.prune()).toEqual([{ cache: "acme", freed: 0 }]);
    expect(run.mock.calls.map(([file, args]) => [file, ...args].join(" "))).toEqual([
      "acme --version",
      "acme gc",
    ]);

    expect(volume).not.toHaveBeenCalled();
  });

  it("finds each tool's cache where the tool puts it", () => {
    const folders = (env: NodeJS.ProcessEnv) =>
      Object.fromEntries(CACHE_RULES.map((r) => [r.tool, r.folder("/home/marcus", env)]));

    expect(folders({})).toEqual({
      mise: "/home/marcus/.cache/mise",
      pnpm: "/home/marcus/.local/share/pnpm",
      npm: "/home/marcus/.npm",
    });

    expect(folders({ XDG_CACHE_HOME: "/cache", XDG_DATA_HOME: "/data" })).toMatchObject({
      mise: "/cache/mise",
      pnpm: "/data/pnpm",
    });

    expect(
      folders({ MISE_CACHE_DIR: "/var/mise", npm_config_cache: "/npm", XDG_DATA_HOME: "/data" }),
    ).toEqual({ mise: "/var/mise", pnpm: "/data/pnpm", npm: "/npm" });
  });

  it("finds nothing old in a folder that does not exist", async () => {
    expect(await removeOlderThan(join(tmpdir(), "ost-no-such-folder"), NOW)).toBe(0);
  });
});
