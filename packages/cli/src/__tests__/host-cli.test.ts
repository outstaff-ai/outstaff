import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecProgram } from "@outstaff/agent";
import { AdapterRegistry, type RepoRef } from "@outstaff/core";
import { createFakeAdapterRegistry, createFakeVcs } from "@outstaff/core/fakes";
import { describe, expect, it } from "vitest";
import { run } from "#/program.js";

const repo = (name: string): Required<RepoRef> => ({
  host: "github.com",
  owner: "acme-example",
  name,
});

const TEAM = `
version: 1
team: { name: acme, product: Acme Shop }
humans:
  - { name: Ada Admin, identities: { chat: U1 } }
catalog: { version: 0.0.0 }
repos:
  - { name: shop, url: github.com/acme-example/shop, kind: primary }
people:
  - { handle: sam, name: Sam Duarte, role: developer, model: sonnet, repos: { shop: write } }
integrations:
  chat: { adapter: fake }
  vcs: { adapter: fake }
  runtime: { adapter: fake }
`;

/** `ost host-cli` the way the wrapper runs it: team file on disk, secrets only as files, a code host with a CLI. */
async function hostCli(
  args: string[],
  o: { exec?: ExecProgram; which?: (c: string) => string | undefined; person?: string } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "ost-hc-"));
  mkdirSync(join(dir, "team", ".outstaff"), { recursive: true });
  writeFileSync(join(dir, "team", ".outstaff", "team.yaml"), TEAM);
  mkdirSync(join(dir, "secrets"));
  mkdirSync(join(dir, "worktree"));
  const vcs = createFakeVcs({ host: "github.com" });
  await vcs.seed.permission(repo("shop"), "sam", "write");
  vcs.hostCli = {
    command: "gh",
    env: (token, r) => ({ GH_TOKEN: token, GH_REPO: `${r.owner}/${r.name}` }),
    tool: { version: "2.103.3" },
  };

  const fake = createFakeAdapterRegistry().get("vcs", "fake")!;
  const registry = new AdapterRegistry().register({ ...fake, create: () => vcs });
  let err = "";
  const code = await run(["host-cli", "--", ...args], {
    cwd: join(dir, "worktree"),
    env: {
      OUTSTAFF_PERSON: o.person ?? "sam",
      OUTSTAFF_TEAM_FILE: join(dir, "team"),
      OUTSTAFF_SECRETS_DIR: join(dir, "secrets"),
      HOME: join(dir, "home"),
      // Nothing on it: a runner with gh installed must not run the real one.
      PATH: join(dir, "bin"),
    },
    out: () => {},
    err: (t) => void (err += t),
    gitOrigin: () => "https://github.com/acme-example/shop.git",
    registry,
    ...(o.exec ? { exec: o.exec } : {}),
    ...(o.which ? { which: o.which } : {}),
  });

  return { code, err, dir };
}

describe("ost host-cli", () => {
  it("runs the CLI with a token for the working directory's repository, passing every argument", async () => {
    const seen: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const r = await hostCli(["run", "view", "9", "--log-failed", "--json", "jobs"], {
      which: (c) => `/opt/${c}`,
      exec: async (file, args, { env }) => {
        seen.push({ file, args, env });
        return 0;
      },
    });

    expect(r).toMatchObject({ code: 0, err: "" });
    expect(seen[0]!.file).toBe("/opt/gh");
    expect(seen[0]!.args).toEqual(["run", "view", "9", "--log-failed", "--json", "jobs"]);
    expect(seen[0]!.env).toMatchObject({
      GH_TOKEN: "fake-token-sam-write",
      GH_REPO: "acme-example/shop",
      OUTSTAFF_PERSON: "sam",
    });
  });

  it("runs the real program with the caller's standard streams and returns its exit code", async () => {
    const r = await hostCli(["-c", 'test "$GH_REPO" = acme-example/shop && exit 4'], {
      which: () => "/bin/sh",
    });

    expect(r.code).toBe(4);
  });

  it("finds the real program on the PATH, past the wrapper", async () => {
    const r = await hostCli(["run", "list"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("gh is not installed");
  });

  it("reports a person who cannot act", async () => {
    const r = await hostCli(["run", "list"], { person: "nobody", which: () => "/bin/true" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("error    invalid: nobody is not a person of the team");
  });
});
