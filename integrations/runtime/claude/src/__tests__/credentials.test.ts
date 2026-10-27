import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { RunRequest, RuntimeEvent } from "@outstaff/core";
import { sampleRunRequest } from "@outstaff/core/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { agentSdkOptions } from "#/options.js";
import { createAgentSdkRuntime } from "#/runtime.js";
import { codePolicy, fakeQuery, init, result } from "#/testing.js";

const bubblewrap = agentSdkOptions.parse({ sandbox: "bubblewrap" });
const req = (o: Partial<RunRequest> = {}): RunRequest =>
  sampleRunRequest({ policy: codePolicy(), workdir: "/work/repos/acme", ...o });

async function drain(stream: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const out: RuntimeEvent[] = [];
  for await (const e of stream) {
    out.push(e);
  }

  return out;
}

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }

  dirs = [];
});

/** A secrets folder holding a file for each key. */
function secretsDir(keys: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "ost-secrets-"));
  dirs.push(dir);
  for (const k of keys) {
    writeFileSync(join(dir, k), `value-of-${k}`);
  }

  return dir;
}

describe("Claude credential files in the bubblewrap sandbox", () => {
  it("denies the credential files the secrets folder holds, and nothing else", async () => {
    const dir = secretsDir([
      "CLAUDE_CODE_OAUTH_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "GH_APP_PRIVATE_KEY",
      "OUTSTAFF_AGENT_TOKEN",
    ]);

    const { query, calls } = fakeQuery(() => [init("s1"), result()]);
    await drain(
      createAgentSdkRuntime({ options: bubblewrap, query, env: {}, secretsDir: dir }).run(req()),
    );

    expect(calls[0]!.options.settings).toEqual({
      disableClaudeAiConnectors: true,
      disableBundledSkills: true,
      enableArtifact: false,
      sandbox: {
        credentials: {
          files: [
            { path: join(dir, "CLAUDE_CODE_OAUTH_TOKEN"), mode: "deny" },
            { path: join(dir, "AWS_SECRET_ACCESS_KEY"), mode: "deny" },
          ],
        },
      },
    });
  });

  it("reads the folder from OUTSTAFF_SECRETS_DIR, and adds no sandbox settings when it holds no credential", async () => {
    const withKey = secretsDir(["ANTHROPIC_API_KEY"]);
    const empty = secretsDir(["GH_APP_PRIVATE_KEY"]);
    const { query, calls } = fakeQuery(() => [init("s1"), result()]);
    const options = bubblewrap;
    await drain(
      createAgentSdkRuntime({ options, query, env: { OUTSTAFF_SECRETS_DIR: withKey } }).run(req()),
    );

    await drain(
      createAgentSdkRuntime({ options, query, env: { OUTSTAFF_SECRETS_DIR: empty } }).run(req()),
    );

    expect(JSON.stringify(calls[0]!.options.settings)).toContain(
      join(withKey, "ANTHROPIC_API_KEY"),
    );

    expect(calls[1]!.options.settings).toEqual({
      disableClaudeAiConnectors: true,
      disableBundledSkills: true,
      enableArtifact: false,
    });
  });

  it("leaves the files alone with sandbox: off, where there is no sandbox to hide them in", async () => {
    const dir = secretsDir(["ANTHROPIC_API_KEY"]);
    const { query, calls } = fakeQuery(() => [init("s1"), result()]);
    await drain(
      createAgentSdkRuntime({
        options: agentSdkOptions.parse({}),
        query,
        env: {},
        secretsDir: dir,
      }).run(req()),
    );

    expect(calls[0]!.options.settings).not.toHaveProperty("sandbox");
  });

  // The deny was verified against Claude Code with its --settings flag; this pins that the SDK's `settings` option is
  // what reaches that flag, by running the real SDK against a stand-in executable that records its arguments.
  it("reaches Claude Code as --settings through the real SDK", { timeout: 30_000 }, async () => {
    const dir = secretsDir(["ANTHROPIC_API_KEY"]);
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const argvFile = join(bin, "argv.json");
    const claude = join(bin, "claude");
    writeFileSync(
      claude,
      `#!/usr/bin/env node\nrequire("fs").writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(1);\n`,
    );

    chmodSync(claude, 0o755);

    const rt = createAgentSdkRuntime({
      options: agentSdkOptions.parse({ claudeCodePath: claude, sandbox: "bubblewrap" }),
      query: sdkQuery,
      env: { PATH: process.env["PATH"] ?? "" },
      secretsDir: dir,
    });

    const events = await drain(rt.run(req({ workdir: dir })));
    expect(events.at(-1)).toMatchObject({ type: "finished", ok: false });

    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]!) as Record<string, unknown>;
    expect(settings).toMatchObject({
      sandbox: { credentials: { files: [{ path: join(dir, "ANTHROPIC_API_KEY"), mode: "deny" }] } },
    });
  });
});
