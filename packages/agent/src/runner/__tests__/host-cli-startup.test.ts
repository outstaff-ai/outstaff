import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeVcs } from "@outstaff/core/fakes";
import { describe, expect, it } from "vitest";
import { installHostCli } from "#/runner/startup-steps.js";
import type { StartupOptions } from "#/runner/startup.types.js";

const options = (home: string, paths: string[]) =>
  ({ home, tools: { addToPath: (dir: string) => paths.push(dir) } }) as unknown as StartupOptions;

describe("installHostCli", () => {
  it("puts the wrapper of the code host's CLI on the PATH", () => {
    const home = mkdtempSync(join(tmpdir(), "ost-host-cli-"));
    const vcs = createFakeVcs();
    vcs.hostCli = { command: "gh", env: () => ({}), tool: { version: "2.103.3" } };
    const paths: string[] = [];
    installHostCli(options(home, paths), { vcs });
    expect(paths).toEqual([join(home, ".local/share/outstaff/bin")]);
    expect(existsSync(join(paths[0]!, "gh"))).toBe(true);
  });

  it("does nothing without a code host, or one without a CLI", () => {
    const paths: string[] = [];
    installHostCli(options("/nowhere", paths), {});
    installHostCli(options("/nowhere", paths), { vcs: createFakeVcs() });
    expect(paths).toEqual([]);
  });
});
