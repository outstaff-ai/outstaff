import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PortError, type HostCli, type RepoRef } from "@outstaff/core";
import { createFakeVcs } from "@outstaff/core/fakes";
import { acmeTeam } from "@outstaff/testing.agent";
import { describe, expect, it, vi } from "vitest";
import { createHostCliRunner, repoFlag, teamRepoFor } from "#/repos/host-cli.js";
import { hostCliBinDir, installHostCliWrapper, whichPast } from "#/repos/host-cli-wrapper.js";
import type { ExecProgram, HostCliRunnerOptions } from "#/repos/types.js";

const host = "github.com";
const ref = (name: string): Required<RepoRef> => ({ host, owner: "acme-example", name });
const ORIGINS: Record<string, string> = {
  "/w/shop": "https://github.com/acme-example/shop.git",
  "/w/ds": "git@github.com:acme-example/design-system.git",
  "/w/infra": "https://github.com/acme-example/infra",
  "/w/other": "https://github.com/someone/else.git",
};

const cli: HostCli = {
  command: "gh",
  env: (token, repo) => ({ GH_TOKEN: token, GH_REPO: `${repo.owner}/${repo.name}` }),
  tool: { version: "2.103.3" },
};

async function runner(over: Partial<HostCliRunnerOptions> = {}) {
  const vcs = createFakeVcs({ host });
  await vcs.seed.permission(ref("shop"), "sam", "write");
  await vcs.seed.permission(ref("design-system"), "sam", "read");
  vcs.hostCli = cli;
  const credentials = vi.spyOn(vcs, "credentials");
  const runs: { file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
  const exec: ExecProgram = async (file, args, opts) => {
    runs.push({ file, args, ...opts });
    return 3;
  };

  const errors: string[] = [];
  const env = { PATH: "/usr/bin", HOME: "/home/outstaff" };
  const r = createHostCliRunner({
    team: acmeTeam(),
    person: "sam",
    vcs,
    profile: "code",
    env,
    origin: (cwd) => ORIGINS[cwd],
    which: (command) => `/opt/bin/${command}`,
    exec,
    err: (t) => errors.push(t),
    ...over,
  });

  return { r, vcs, credentials, runs, errors, env };
}

describe("host CLI runner", () => {
  it("runs the real CLI with a fresh token for the working directory's repository, in its environment only", async () => {
    const { r, credentials, runs, env } = await runner();
    expect(await r.run(["run", "rerun", "9"], "/w/shop")).toBe(3);
    expect(credentials).toHaveBeenLastCalledWith("sam", ref("shop"), "write", "cli");
    expect(runs[0]).toEqual({
      file: "/opt/bin/gh",
      args: ["run", "rerun", "9"],
      cwd: "/w/shop",
      env: {
        PATH: "/usr/bin",
        HOME: "/home/outstaff",
        GH_TOKEN: "fake-token-sam-write",
        GH_REPO: "acme-example/shop",
      },
    });

    // The token went to the one process: the environment the runner was given, and its own, never hold it.
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/outstaff" });
    expect(process.env["GH_TOKEN"]).toBeUndefined();

    await r.run(["run", "view", "9"], "/w/shop");
    expect(credentials).toHaveBeenCalledTimes(2);
  });

  it("acts on the -R repository, at the access the grant and the role give", async () => {
    const { r, credentials, runs } = await runner({ profile: "readonly" });
    await r.run(["pr", "view", "3", "-R", "acme-example/shop"], "/w/other");
    expect(credentials).toHaveBeenLastCalledWith("sam", ref("shop"), "read", "cli");
    expect(runs[0]!.env["GH_TOKEN"]).toBe("fake-token-sam-read");

    await r.run(["pr", "view", "--repo=github.com/acme-example/design-system"], "/w/shop");
    expect(credentials).toHaveBeenLastCalledWith("sam", ref("design-system"), "read", "cli");
  });

  it("uses the clone's origin over ssh too", async () => {
    const { r, credentials } = await runner();
    await r.run(["run", "list"], "/w/ds");
    expect(credentials).toHaveBeenLastCalledWith("sam", ref("design-system"), "read", "cli");
  });

  it.each([
    ["/w/other", [], "needs a team repository"],
    ["/nowhere", [], "needs a team repository"],
    ["/w/shop", ["-R", "acme-example"], "needs a team repository"],
    ["/w/shop", ["-R", "other.example/acme-example/shop"], "needs a team repository"],
    ["/w/infra", [], "sam has no grant on infra"],
  ])("refuses in %s with %j: %s", async (cwd, extra, message) => {
    const { r, credentials, runs, errors } = await runner();
    expect(await r.run(["pr", "list", ...extra], cwd)).toBe(1);
    expect(errors.join("")).toContain(message);
    expect(credentials).not.toHaveBeenCalled();
    expect(runs).toHaveLength(0);
  });

  it("says how to install the CLI when it is not on the PATH, before minting anything", async () => {
    const { r, credentials, errors } = await runner({ which: () => undefined });
    expect(await r.run(["run", "list"], "/w/shop")).toBe(1);
    expect(errors.join("")).toContain('gh: { version: "2.103.3" }');
    expect(credentials).not.toHaveBeenCalled();

    const sourced = await runner({ which: () => undefined });
    sourced.vcs.hostCli = { ...cli, tool: { version: "1.0.0", source: "ubi:acme/gh" } };
    await sourced.r.run([], "/w/shop");
    expect(sourced.errors.join("")).toContain('source: "ubi:acme/gh"');
  });

  it("refuses when the code host has no CLI", async () => {
    const { r, vcs, errors } = await runner();
    delete vcs.hostCli;
    expect(await r.run(["run", "list"], "/w/shop")).toBe(1);
    expect(errors.join("")).toContain("no CLI");
  });

  it("reports a refused token and rethrows anything else", async () => {
    const { r, credentials, errors } = await runner();
    credentials.mockRejectedValueOnce(new PortError("forbidden", "the App is not installed"));
    expect(await r.run(["run", "list"], "/w/shop")).toBe(1);
    expect(errors.join("")).toContain("forbidden: the App is not installed");

    credentials.mockRejectedValueOnce(new Error("boom"));
    await expect(r.run(["run", "list"], "/w/shop")).rejects.toThrow("boom");
  });
});

describe("repoFlag and teamRepoFor", () => {
  it.each([
    [["-R", "a/b"], "a/b"],
    [["--repo", "a/b"], "a/b"],
    [["--repo=a/b"], "a/b"],
    [["-Ra/b"], "a/b"],
    [["-R=a/b"], "a/b"],
    [["pr", "view", "--", "-R", "a/b"], undefined],
    [["pr", "view"], undefined],
  ])("reads %j as %s", (args, want) => {
    expect(repoFlag(args)).toBe(want);
  });

  it("matches on owner and name, and on the host when given", () => {
    const team = acmeTeam();
    expect(teamRepoFor(team, { owner: "Acme-Example", name: "Shop" })?.name).toBe("shop");
    expect(teamRepoFor(team, ref("shop"))?.name).toBe("shop");
    expect(teamRepoFor(team, { ...ref("shop"), host: "other.example" })).toBeUndefined();
  });
});

describe("host CLI wrapper", () => {
  it("writes an executable wrapper that holds no secret and calls ost host-cli", () => {
    const home = mkdtempSync(join(tmpdir(), "ost-wrapper-"));
    const dir = installHostCliWrapper(home, "gh");
    expect(dir).toBe(hostCliBinDir(home));
    expect(readFileSync(join(dir, "gh"), "utf8")).toBe('#!/bin/sh\nexec ost host-cli -- "$@"\n');

    expect(statSync(join(dir, "gh")).mode & 0o111).not.toBe(0);
  });

  it("finds the real program past the wrapper's own directory", () => {
    const root = mkdtempSync(join(tmpdir(), "ost-which-"));
    const wrapper = join(root, "wrapper");
    const real = join(root, "real");
    const plain = join(root, "plain");
    for (const dir of [wrapper, real, plain]) {
      mkdirSync(dir);
    }

    writeFileSync(join(wrapper, "gh"), "");
    chmodSync(join(wrapper, "gh"), 0o755);
    writeFileSync(join(plain, "gh"), "");
    writeFileSync(join(real, "gh"), "");
    chmodSync(join(real, "gh"), 0o755);

    const path = ["", `${wrapper}/`, plain, real].join(delimiter);
    expect(whichPast("gh", path, wrapper)).toBe(join(real, "gh"));
    expect(whichPast("gh", wrapper, wrapper)).toBeUndefined();
    expect(whichPast("gh", undefined, wrapper)).toBeUndefined();
  });
});
