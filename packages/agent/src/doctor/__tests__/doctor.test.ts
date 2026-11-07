import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { silentLogger, type Logger, type TeamConfig } from "@outstaff/core";
import { describe, expect, it, vi } from "vitest";
import { actsCheck } from "#/doctor/acts.js";
import { diskCheck, volumeUsage } from "#/doctor/disk.js";
import { reportAgentChecks, reportStartupChecks, startupChecks } from "#/doctor/startup.js";
import { repoChecks } from "#/doctor/repos.js";
import { extensionChecks, toolPathChecks, toolStatusChecks } from "#/doctor/tools.js";

const GIB = 1024 ** 3;
const volume = (used: number) => async () => ({ used: used * GIB, total: 100 * GIB });

const sam = {
  handle: "sam",
  name: "Sam",
  role: "developer",
  model: "sonnet",
} as TeamConfig["people"][number];

const team = { people: [sam], integrations: {} } as unknown as TeamConfig;

describe("the agent's startup checks", () => {
  it("reports each tool that did not install, or that all did", () => {
    expect(toolStatusChecks([])).toEqual([]);
    expect(
      toolStatusChecks([
        { name: "jq", version: "1.7.1", state: "installed" },
        { name: "node", version: "24", state: "cached" },
      ]),
    ).toEqual([{ name: "Tools install", status: "ok", detail: "jq@1.7.1, node@24 installed." }]);

    expect(
      toolStatusChecks([
        { name: "jq", version: "9", state: "unavailable", error: "jq@9 does not exist." },
        { name: "yq", version: "4", state: "unavailable" },
      ]),
    ).toEqual([
      expect.objectContaining({
        name: "Tool jq installs",
        status: "fail",
        detail: "jq@9 does not exist.",
      }),
      expect.objectContaining({
        name: "Tool yq installs",
        status: "fail",
        detail: "yq@4 did not install.",
      }),
    ]);
  });

  it("reports each declared extension that did not install, with the error, or that all did", () => {
    const gh = { name: "gh", version: "2.103.3", state: "cached" as const };
    const lock = {
      tool: "gh",
      extension: "github/gh-actions-lock@v1.2.0",
      command: "actions-lock",
      state: "installed" as const,
    };

    expect(extensionChecks([gh])).toEqual([]);
    expect(extensionChecks([{ ...gh, extensions: [lock] }])).toEqual([
      {
        name: "Tool extensions install",
        status: "ok",
        detail: "gh github/gh-actions-lock@v1.2.0 installed.",
      },
    ]);

    const failed = { ...lock, state: "unavailable" as const, error: "no release v1.2.0" };
    expect(extensionChecks([{ ...gh, extensions: [failed, lock] }])).toEqual([
      expect.objectContaining({
        name: "Extension github/gh-actions-lock@v1.2.0 of gh installs",
        status: "fail",
        detail: "no release v1.2.0",
      }),
    ]);

    const { error: _, ...silent } = failed;
    expect(extensionChecks([{ ...gh, extensions: [silent] }])[0]).toMatchObject({
      detail: "github/gh-actions-lock@v1.2.0 did not install.",
    });
  });

  it("reports each declared tool that is not on the PATH, or that all are", () => {
    const pnpm = { name: "pnpm", version: "12.9.1", state: "installed" as const };
    const kubectl = { name: "kubectl", version: "1.31.3", state: "cached" as const };
    const broken = { name: "helm", version: "3", state: "unavailable" as const };
    const onPath = (file: string) => file === "/shims/pnpm" || file === "/usr/bin/kubectl";
    const env = { PATH: ["/shims", "/usr/bin"].join(delimiter) };

    expect(toolPathChecks([], env, onPath)).toEqual([]);
    expect(toolPathChecks([broken], env, onPath)).toEqual([]);
    expect(toolPathChecks([pnpm, kubectl, broken], env, onPath)).toEqual([
      { name: "Tools on PATH", status: "ok", detail: "pnpm, kubectl found on the PATH." },
    ]);

    expect(toolPathChecks([pnpm, kubectl], { PATH: "/usr/bin" }, onPath)).toEqual([
      expect.objectContaining({
        name: "Tool pnpm on PATH",
        status: "fail",
        detail: expect.stringContaining("pnpm is declared for this agent but is not on its PATH"),
      }),
    ]);

    expect(toolPathChecks([pnpm], {}, onPath)[0]?.detail).toContain("(empty)");
  });

  it("finds a tool on the real PATH only as an executable file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ost-path-"));
    writeFileSync(join(dir, "acme-cli"), "#!/bin/sh\n");
    chmodSync(join(dir, "acme-cli"), 0o755);
    writeFileSync(join(dir, "acme-doc"), "text\n");
    mkdirSync(join(dir, "acme-dir"));
    const tool = (name: string) => ({ name, version: "1", state: "installed" as const });
    const env = { PATH: dir };

    expect(toolPathChecks([tool("acme-cli")], env)).toMatchObject([{ status: "ok" }]);
    expect(
      toolPathChecks([tool("acme-doc"), tool("acme-dir"), tool("acme-none")], env).map(
        (c) => c.name,
      ),
    ).toEqual(["Tool acme-doc on PATH", "Tool acme-dir on PATH", "Tool acme-none on PATH"]);
  });

  it("warns from 80% of the home volume used and fails from 90%", async () => {
    expect(await diskCheck("/home/agent", volume(79))).toEqual({
      name: "Home volume space",
      status: "ok",
      detail: "/home/agent: 79.0 GiB of 100.0 GiB used (79%).",
    });

    expect(await diskCheck("/home/agent", volume(80))).toMatchObject({
      status: "warn",
      fix: "Free space or grow the volume.",
    });

    expect(await diskCheck("/home/agent", volume(90))).toMatchObject({
      status: "fail",
      detail: "/home/agent: 90.0 GiB of 100.0 GiB used (90%).",
      fix: "Free space or grow the volume.",
    });

    expect(await diskCheck("/x", async () => ({ used: 0, total: 0 }))).toMatchObject({
      status: "ok",
    });

    expect(await diskCheck("/x", () => Promise.reject(new Error("ENOENT")))).toEqual({
      name: "Home volume space",
      status: "warn",
      detail: "The usage of /x could not be read: ENOENT",
    });
  });

  it("names what fills the volume in the fix, measuring only once it warns", async () => {
    const largest = "Largest in the home: worktrees 1.2 GiB (15 items, 14 blocked or waiting).";
    const breakdown = vi.fn<() => Promise<string>>(async () => largest);

    expect(await diskCheck("/home/agent", volume(79), breakdown)).not.toHaveProperty("fix");
    expect(breakdown).not.toHaveBeenCalled();

    expect(await diskCheck("/home/agent", volume(81), breakdown)).toMatchObject({
      status: "warn",
      fix: `${largest} Free space or grow the volume.`,
    });

    const failing = () => Promise.reject(new Error("EACCES"));
    expect(await diskCheck("/home/agent", volume(95), failing)).toMatchObject({
      status: "fail",
      fix: "Free space or grow the volume.",
    });
  });

  it("reads a real volume", async () => {
    const usage = await volumeUsage(tmpdir());
    expect(usage.total).toBeGreaterThan(0);
    expect(usage.used).toBeLessThanOrEqual(usage.total);
  });

  it("runs the tool, network and disk checks and reports them, logging what is not ok", async () => {
    const input = {
      env: {},
      home: "/home/agent",
      team,
      person: { ...sam, network: { http: [{ name: "hub", url: "http://hub.acme.example" }] } },
      tools: [{ name: "jq", version: "9", state: "unavailable" as const }],
      fetch: () => Promise.reject(new Error("refused")),
      volume: volume(10),
    };

    expect((await startupChecks(input)).map((c) => [c.name, c.status])).toEqual([
      ["Tool jq installs", "fail"],
      ["Service hub answers", "fail"],
      ["Home volume space", "ok"],
    ]);

    const warned: string[] = [];
    const log = { ...silentLogger, warn: (m: string) => void warned.push(m) } as Logger;
    const sent: unknown[] = [];
    await reportStartupChecks(input, async (checks) => void sent.push(checks), log);
    expect(sent).toHaveLength(1);
    expect(warned).toEqual(["doctor: Tool jq installs", "doctor: Service hub answers"]);

    await reportStartupChecks(input, () => Promise.reject(new Error("offline")), log);
    expect(warned.at(-1)).toBe("could not report the startup checks to the office");
    await reportStartupChecks({ ...input, tools: [] }, () => Promise.reject("down"));
  });

  it("checks that the tracker port the agent makes its acts with started", () => {
    const withTracker = { integrations: { tracker: { adapter: "itsaplan" } } } as TeamConfig;
    expect(actsCheck(team, {})).toEqual([]);
    expect(actsCheck(withTracker, { tracker: {} as never })).toMatchObject([
      { name: "Tracker acts", status: "ok" },
    ]);

    expect(
      actsCheck(withTracker, { unavailable: { tracker: "ITSAPLAN_API_KEY is missing" } }),
    ).toEqual([
      {
        name: "Tracker acts",
        status: "fail",
        detail:
          "The tracker port did not start (ITSAPLAN_API_KEY is missing), so every act the office sends this agent fails.",
        fix: "Run `ost doctor` for the person to check the tracker integration and its secrets, then restart the agent.",
      },
    ]);

    expect(actsCheck(withTracker, {})[0]?.detail).toContain("(no reason given)");
  });

  it("reports each repository that could not be prepared, with the error, or that all were", () => {
    const shop = { name: "shop" } as never;
    expect(repoChecks(undefined)).toEqual([]);
    expect(repoChecks({ ready: [], unprepared: () => [] })).toEqual([]);
    expect(repoChecks({ ready: [shop], unprepared: () => [] })).toEqual([
      { name: "Repositories prepare", status: "ok", detail: "shop cloned and fetched." },
    ]);

    const libs = {
      name: "libs",
      dir: "/home/agent/repos/libs",
      ref: { host: "github.com", owner: "acme", name: "libs" },
      access: "write" as const,
      kind: "library",
      error: "git fetch failed: could not read Username",
    };

    expect(repoChecks({ ready: [shop], unprepared: () => [libs] })).toEqual([
      {
        name: "Repository libs prepares",
        status: "fail",
        detail: "libs could not be prepared: git fetch failed: could not read Username",
        fix: expect.stringContaining("Check libs's url in team.yaml") as string,
      },
    ]);
  });

  it("reports a prepared agent's checks over its connection", async () => {
    const sent: unknown[] = [];
    await reportAgentChecks(
      {
        team,
        person: "sam",
        tools: [{ name: "jq", version: "1.7.1", state: "installed" }],
        connection: { doctorReport: async (checks: unknown) => void sent.push(checks) } as never,
        env: {
          person: "sam",
          team,
          repositories: { ready: [{ name: "shop" } as never], unprepared: () => [] },
        },
      },
      {},
      tmpdir(),
    );

    expect(sent).toEqual([
      expect.arrayContaining([
        expect.objectContaining({ name: "Tools install", status: "ok" }),
        expect.objectContaining({ name: "Tool jq on PATH", status: "fail" }),
        expect.objectContaining({ name: "Repositories prepare", status: "ok" }),
      ]),
    ]);
  });
});
