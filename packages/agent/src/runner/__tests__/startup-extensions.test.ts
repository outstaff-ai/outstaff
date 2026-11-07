import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { silentLogger, type EffectiveTool, type HostCli } from "@outstaff/core";
import { createFakeVcs } from "@outstaff/core/fakes";
import { acmeTeam } from "@outstaff/testing.agent";
import { describe, expect, it } from "vitest";
import { installToolExtensions, tokenRepo } from "#/runner/startup-extensions.js";
import type { StartupOptions } from "#/runner/startup.types.js";
import type { ToolStatus } from "#/tools/index.js";

const LOCK = { owner: "github", name: "gh-actions-lock", ref: "v1.2.0" };

describe("tokenRepo", () => {
  const team = acmeTeam();

  it("takes the extension's own repository when the team lists it and the person has a grant", () => {
    expect(tokenRepo(team, "sam", { ...LOCK, owner: "acme-example", name: "design-system" })).toBe(
      "acme-example/design-system",
    );
  });

  it("else the first repository the person has a grant on", () => {
    expect(tokenRepo(team, "sam", LOCK)).toBe("acme-example/shop");
  });

  it("gives none to someone who is not on the team, or has no grant", () => {
    expect(tokenRepo(team, "nobody", LOCK)).toBeUndefined();
    const none = { ...team, people: team.people.map((p) => ({ ...p, repos: {} })) };
    expect(tokenRepo(none, "sam", LOCK)).toBeUndefined();
  });
});

/**
 * A home with a fake `gh` on the PATH: it records its arguments and the token it was given, and creates the
 * extension's directory, unless its repository is acme-example/gh-broken.
 */
function fakeGh() {
  const home = mkdtempSync(join(tmpdir(), "ost-start-ext-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  const log = join(home, "gh.log");
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      `echo "$* token=$GH_TOKEN" >> "${log}"`,
      'case "$3" in */gh-broken) echo "could not find a release" >&2; exit 1;; esac',
      'mkdir -p "$HOME/ext/${3#*/}"',
      "",
    ].join("\n"),
  );

  chmodSync(join(bin, "gh"), 0o755);
  return { home, log, env: { PATH: [bin, "/usr/bin", "/bin"].join(delimiter), HOME: home } };
}

const cli: HostCli = {
  command: "gh",
  env: (token) => ({ GH_TOKEN: token }),
  tool: { version: "2.103.3" },
  extensions: {
    command: (name) => /^gh-(.+)$/.exec(name)?.[1],
    install: (ext) => ["extension", "install", `${ext.owner}/${ext.name}`, "--pin", ext.ref],
    dir: (ext, env) => join(env["HOME"]!, "ext", ext.name),
  },
};

const gh = (extensions?: string[]): EffectiveTool => ({
  name: "gh",
  version: "2.103.3",
  origin: "team",
  ...(extensions ? { extensions } : {}),
});

describe("installToolExtensions", () => {
  async function start(tools: EffectiveTool[], statuses: ToolStatus[]) {
    const { home, log, env } = fakeGh();
    const vcs = createFakeVcs({ host: "github.com" });
    const shop = { host: "github.com", owner: "acme-example", name: "shop" };
    await vcs.seed.permission(shop, "sam", "write");
    vcs.hostCli = cli;
    const out = await installToolExtensions(
      { home, env } as unknown as StartupOptions,
      { vcs },
      { team: acmeTeam(), person: "sam", profile: "code", log: silentLogger },
      tools,
      statuses,
    );

    return { out, home, log };
  }

  it("installs each declared extension with the real CLI and a token for the call, and notes it on the tool", async () => {
    const statuses: ToolStatus[] = [{ name: "gh", version: "2.103.3", state: "installed" }];
    const { out, home, log } = await start(
      [gh(["acme-example/gh-hello@v1.0.0", "acme-example/gh-broken@v2.0.0"])],
      statuses,
    );

    expect(out).toEqual([
      {
        tool: "gh",
        extension: "acme-example/gh-hello@v1.0.0",
        command: "hello",
        state: "installed",
      },
      {
        tool: "gh",
        extension: "acme-example/gh-broken@v2.0.0",
        command: "broken",
        state: "unavailable",
        error: "acme-example/gh-broken@v2.0.0 could not be installed: could not find a release",
      },
    ]);

    expect(statuses[0]!.extensions).toEqual(out);
    expect(existsSync(join(home, "ext/gh-hello"))).toBe(true);
    expect(readFileSync(log, "utf8")).toContain(
      "extension install acme-example/gh-hello --pin v1.0.0 token=fake-token-sam-write",
    );
  });

  it("does nothing when no tool declares extensions", async () => {
    const statuses: ToolStatus[] = [{ name: "gh", version: "2.103.3", state: "installed" }];
    expect((await start([gh()], statuses)).out).toEqual([]);
    expect(statuses[0]!.extensions).toBeUndefined();
  });
});
