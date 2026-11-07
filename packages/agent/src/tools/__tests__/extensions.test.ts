import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EffectiveTool, HostCli, ToolExtension } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { extensionsStateFile, installExtensions, usableExtensions } from "#/tools/index.js";

/** A CLI whose extensions are `x-<command>` repositories kept in `<HOME>/ext/<name>`. */
const cli: HostCli = {
  command: "x",
  env: () => ({}),
  tool: { version: "1.0.0" },
  extensions: {
    command: (name) => /^x-(.+)$/.exec(name)?.[1],
    install: (ext) => ["ext", "install", `${ext.owner}/${ext.name}`, "--pin", ext.ref],
    dir: (ext, env) => join(env["HOME"]!, "ext", ext.name),
  },
};

const tool = (extensions: string[], name = "x"): EffectiveTool => ({
  name,
  version: "1.0.0",
  origin: "team",
  extensions,
});

/** Installs by creating the extension's directory, as the CLI would; records each install it ran. */
function setup(fail?: (ext: ToolExtension) => string | undefined) {
  const home = mkdtempSync(join(tmpdir(), "ost-ext-"));
  const runs: string[][] = [];
  const install = (tools: EffectiveTool[], over: Partial<{ cli: HostCli | undefined }> = {}) =>
    installExtensions({
      tools,
      cli: "cli" in over ? over.cli : cli,
      home,
      env: { HOME: home },
      run: async (ext, args) => {
        runs.push(args);
        const reason = fail?.(ext);
        if (reason) {
          return { code: 1, output: `starting\n${reason}\n` };
        }

        mkdirSync(join(home, "ext", ext.name), { recursive: true });
        writeFileSync(join(home, "ext", ext.name, "ref"), ext.ref);
        return { code: 0, output: "" };
      },
    });

  return { home, runs, install };
}

describe("installExtensions", () => {
  it("installs a declared extension once, and keeps it across restarts", async () => {
    const { home, runs, install } = setup();
    expect(await install([tool(["acme/x-hello@v1.0.0"])])).toEqual([
      { tool: "x", extension: "acme/x-hello@v1.0.0", command: "hello", state: "installed" },
    ]);

    expect(await install([tool(["acme/x-hello@v1.0.0"])])).toMatchObject([{ state: "cached" }]);
    expect(runs).toEqual([["ext", "install", "acme/x-hello", "--pin", "v1.0.0"]]);
    expect(JSON.parse(readFileSync(extensionsStateFile(home), "utf8"))).toEqual({
      "x:acme/x-hello": { ref: "v1.0.0", dir: join(home, "ext/x-hello") },
    });
  });

  it("installs it again at a new version", async () => {
    const { home, runs, install } = setup();
    await install([tool(["acme/x-hello@v1.0.0"])]);
    expect(await install([tool(["acme/x-hello@v2.0.0"])])).toMatchObject([{ state: "installed" }]);

    expect(runs.map((r) => r[4])).toEqual(["v1.0.0", "v2.0.0"]);
    expect(readFileSync(join(home, "ext/x-hello/ref"), "utf8")).toBe("v2.0.0");
  });

  it("installs it again when its directory is gone", async () => {
    const { home, runs, install } = setup();
    await install([tool(["acme/x-hello@v1.0.0"])]);
    rmSync(join(home, "ext"), { recursive: true });
    expect(await install([tool(["acme/x-hello@v1.0.0"])])).toMatchObject([{ state: "installed" }]);

    expect(runs).toHaveLength(2);
  });

  it("removes an extension that is no longer declared", async () => {
    const { home, install } = setup();
    await install([tool(["acme/x-hello@v1.0.0", "acme/x-other@v1.0.0"])]);
    await install([tool(["acme/x-other@v1.0.0"])]);
    expect(existsSync(join(home, "ext/x-hello"))).toBe(false);
    expect(existsSync(join(home, "ext/x-other"))).toBe(true);
    await install([]);
    expect(existsSync(join(home, "ext/x-other"))).toBe(false);
    expect(readFileSync(extensionsStateFile(home), "utf8")).toBe("{}");
  });

  it("reports an install that fails with the CLI's reason, and the others still install", async () => {
    const { install } = setup((ext) =>
      ext.name === "x-broken" ? "error: no release v9.9.9" : undefined,
    );

    const statuses = await install([tool(["acme/x-broken@v9.9.9", "acme/x-hello@v1.0.0"])]);
    expect(statuses).toEqual([
      {
        tool: "x",
        extension: "acme/x-broken@v9.9.9",
        command: "broken",
        state: "unavailable",
        error: "acme/x-broken@v9.9.9 could not be installed: starting error: no release v9.9.9",
      },
      { tool: "x", extension: "acme/x-hello@v1.0.0", command: "hello", state: "installed" },
    ]);

    expect(usableExtensions(statuses)).toEqual([
      { tool: "x", command: "hello", extension: "acme/x-hello@v1.0.0" },
    ]);
  });

  it("reports an install that succeeds but leaves nothing in place", async () => {
    const home = mkdtempSync(join(tmpdir(), "ost-ext-"));
    const [status] = await installExtensions({
      tools: [tool(["acme/x-hello@v1.0.0"])],
      cli,
      home,
      env: { HOME: home },
      run: async () => ({ code: 0, output: "" }),
    });

    expect(status).toMatchObject({
      state: "unavailable",
      error: expect.stringContaining("no output"),
    });
  });

  it("refuses extensions of a tool that is not the code host's CLI, or of no CLI", async () => {
    const { runs, install } = setup();
    expect(await install([tool(["acme/x-hello@v1.0.0"], "kubectl")])).toEqual([
      {
        tool: "kubectl",
        extension: "acme/x-hello@v1.0.0",
        state: "unavailable",
        error: "kubectl takes no extensions here: only the code host's CLI (x) does.",
      },
    ]);

    expect(await install([tool(["acme/x-hello@v1.0.0"])], { cli: undefined })).toMatchObject([
      { error: "x takes no extensions here: only the code host's CLI does." },
    ]);

    const { extensions: _, ...plain } = cli;
    expect(await install([tool(["acme/x-hello@v1.0.0"])], { cli: plain })).toMatchObject([
      { error: "x takes no extensions." },
    ]);

    expect(runs).toEqual([]);
  });

  it("refuses a repository that is not an extension, or an entry it cannot read", async () => {
    const { install } = setup();
    expect(await install([tool(["acme/hello@v1.0.0", "nonsense"])])).toMatchObject([
      { error: "acme/hello is not a x extension: its repository name does not give a command." },
      { error: "nonsense is not <owner>/<repository>@<ref>." },
    ]);
  });

  it("writes no state when nothing is declared", async () => {
    const { home, install } = setup();
    expect(await install([tool([])])).toEqual([]);
    expect(existsSync(extensionsStateFile(home))).toBe(false);
  });
});
