import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveTools } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import {
  globalConfigFile,
  installTools,
  renderGlobalMiseToml,
  renderMiseToml,
  verifyTools,
} from "./install.js";
import { withGlobalConfig } from "./testing.js";
import type { MiseRunner } from "./types.js";

const tools = (version = "1.31.3") =>
  effectiveTools({
    team: {
      kubectl: { version, allow: ["get"] },
      "their-cli": { version: "0.9.1", source: "ubi:vendor/their-cli", allow: "all" },
    },
  });

/** A fake mise: records calls, writes a lockfile on `lock`, reads versions from the global config, and fails the commands `fail` says to. */
function fakeMise(fail: (args: string[]) => string | undefined = () => undefined) {
  const calls: string[][] = [];
  let home = "";
  const ok = withGlobalConfig(async (args, opts) => {
    if (args[0] === "lock") {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        join(opts.cwd, "mise.lock"),
        `# lock for ${readFileSync(join(opts.cwd, "mise.toml"), "utf8").length}\n`,
      );
    }

    return { code: 0, stdout: "", stderr: "" };
  });

  const runner: MiseRunner = async (args, opts) => {
    calls.push(args);
    home = opts.cwd;
    const error = fail(args);
    if (error) {
      return { code: error.includes("not installed") ? 127 : 1, stdout: "", stderr: error };
    }

    return ok(args, opts);
  };

  return { runner, calls, dir: () => home };
}

const homeDir = () => mkdtempSync(join(tmpdir(), "ost-tools-"));

describe("installTools", () => {
  it("writes mise.toml, locks, installs and reports the shims", async () => {
    const home = homeDir();
    const m = fakeMise();
    const r = await installTools({ tools: tools(), home, env: {}, mise: m.runner });

    const dir = join(home, ".config/outstaff/tools");
    const toml = readFileSync(join(dir, "mise.toml"), "utf8");
    expect(toml).toContain('"kubectl" = "1.31.3"');
    expect(toml).toContain('"ubi:vendor/their-cli" = "0.9.1"');
    expect(toml).toContain("lockfile = true");
    expect(m.calls.filter((c) => c[0] !== "where" && c[0] !== "current")).toEqual([
      ["lock"],
      ["install"],
    ]);

    expect(existsSync(join(dir, "mise.lock"))).toBe(true);
    expect(r.statuses.map((s) => [s.name, s.state])).toEqual([
      ["kubectl", "installed"],
      ["their-cli", "installed"],
    ]);

    expect(r.shimsDir).toBe(join(home, ".local/share/mise/shims"));
  });

  it("honours MISE_DATA_DIR for the shims", async () => {
    const r = await installTools({
      tools: tools(),
      home: homeDir(),
      env: { MISE_DATA_DIR: "/data/mise" },
      mise: fakeMise().runner,
    });

    expect(r.shimsDir).toBe("/data/mise/shims");
  });

  it("installs once and skips while nothing changed", async () => {
    const home = homeDir();
    const m = fakeMise();
    await installTools({ tools: tools(), home, env: {}, mise: m.runner });
    m.calls.length = 0;
    const again = await installTools({ tools: tools(), home, env: {}, mise: m.runner });

    expect(m.calls.filter((c) => c[0] !== "where" && c[0] !== "current")).toEqual([]);
    expect(again.statuses.every((s) => s.state === "cached")).toBe(true);
  });

  it("refreshes the lock and reinstalls when a version changes", async () => {
    const home = homeDir();
    const m = fakeMise();
    await installTools({ tools: tools(), home, env: {}, mise: m.runner });
    m.calls.length = 0;
    const r = await installTools({ tools: tools("1.32.0"), home, env: {}, mise: m.runner });

    expect(m.calls.filter((c) => c[0] !== "where" && c[0] !== "current")).toEqual([
      ["lock"],
      ["install"],
    ]);

    expect(r.statuses[0]).toMatchObject({ name: "kubectl", version: "1.32.0", state: "installed" });
  });

  it("enforces an existing lock with --locked when the list is the one it was made for", async () => {
    const home = homeDir();
    const m = fakeMise();
    await installTools({ tools: tools(), home, env: {}, mise: m.runner });
    // The state is lost (for example a fresh config volume) but the lock and the list are the same.
    const { rmSync, writeFileSync } = await import("node:fs");
    const dir = join(home, ".config/outstaff/tools");
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { config: string };
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({ config: state.config, applied: "stale" }),
    );

    m.calls.length = 0;
    await installTools({ tools: tools(), home, env: {}, mise: m.runner });
    expect(m.calls.filter((c) => c[0] !== "where" && c[0] !== "current")).toEqual([
      ["install", "--locked"],
    ]);

    rmSync(dir, { recursive: true });
  });

  it("names the tool that fails, keeps the others, and retries next start", async () => {
    const home = homeDir();
    const m = fakeMise((a) =>
      a[0] === "install" && a.length === 1
        ? "batch failed"
        : a[1]?.startsWith("ubi:vendor/their-cli")
          ? "404 asset not found"
          : undefined,
    );

    const r = await installTools({ tools: tools(), home, env: {}, mise: m.runner });
    expect(r.statuses).toEqual([
      { name: "kubectl", version: "1.31.3", state: "installed" },
      {
        name: "their-cli",
        version: "0.9.1",
        state: "unavailable",
        error: "their-cli@0.9.1 could not be installed: 404 asset not found",
      },
    ]);

    const m2 = fakeMise();
    const retry = await installTools({ tools: tools(), home, env: {}, mise: m2.runner });
    expect(m2.calls.length).toBeGreaterThan(0);
    expect(retry.statuses.every((s) => s.state === "installed")).toBe(true);
  });

  it("reports mise's reason without its progress and footer", async () => {
    const m = fakeMise((a) =>
      a.length === 1
        ? "mise ERROR Failed to install tools\nmise ERROR Version: 2026.10.18 linux-arm64\nmise ERROR Run with --verbose"
        : a[1] === "kubectl@1.31.3"
          ? "mise ✗ kubectl@1.31.3 372ms\nmise ERROR Failed to install aqua:x/kubectl@1.31.3: HTTP status client error (404 Not Found)\nmise ERROR Version: 2026.10.18 linux-arm64"
          : undefined,
    );

    const r = await installTools({ tools: tools(), home: homeDir(), env: {}, mise: m.runner });
    expect(r.statuses[0]?.error).toBe(
      "kubectl@1.31.3 could not be installed: Failed to install aqua:x/kubectl@1.31.3: HTTP status client error (404 Not Found)",
    );
  });

  it("reports every tool unavailable when mise is missing", async () => {
    const m = fakeMise(() => "mise is not installed in this image.");
    const r = await installTools({ tools: tools(), home: homeDir(), env: {}, mise: m.runner });
    expect(r.statuses.map((s) => s.state)).toEqual(["unavailable", "unavailable"]);
    expect(r.statuses[0]?.error).toContain("mise is not installed");
  });

  it("writes the global config with every declared tool, where mise reads it", async () => {
    const home = homeDir();
    await installTools({ tools: tools(), home, env: {}, mise: fakeMise().runner });

    const file = join(home, ".config/mise/config.toml");
    expect(globalConfigFile(home, {})).toBe(file);
    const toml = readFileSync(file, "utf8");
    expect(toml).toBe(renderGlobalMiseToml(tools()));
    expect(toml).toContain('"kubectl" = "1.31.3"');
    expect(toml).toContain('"ubi:vendor/their-cli" = "0.9.1"');
    expect(toml).not.toContain("lockfile");
  });

  it("writes the global config again on a cached start, and follows a version change", async () => {
    const home = homeDir();
    const m = fakeMise();
    await installTools({ tools: tools(), home, env: {}, mise: m.runner });
    const { rmSync } = await import("node:fs");
    rmSync(join(home, ".config/mise"), { recursive: true });
    const again = await installTools({ tools: tools(), home, env: {}, mise: m.runner });
    expect(again.statuses.every((s) => s.state === "cached")).toBe(true);
    expect(readFileSync(join(home, ".config/mise/config.toml"), "utf8")).toContain('"1.31.3"');

    await installTools({ tools: tools("1.32.0"), home, env: {}, mise: m.runner });
    expect(readFileSync(join(home, ".config/mise/config.toml"), "utf8")).toContain('"1.32.0"');
  });

  it("honours MISE_GLOBAL_CONFIG_FILE", async () => {
    const home = homeDir();
    const file = join(home, "data/mise-global.toml");
    await installTools({
      tools: tools(),
      home,
      env: { MISE_GLOBAL_CONFIG_FILE: file },
      mise: fakeMise().runner,
    });

    expect(existsSync(file)).toBe(true);
    expect(existsSync(join(home, ".config/mise/config.toml"))).toBe(false);
  });

  it("asks mise from the home directory whether each tool resolves", async () => {
    const home = homeDir();
    const m = fakeMise();
    await installTools({ tools: tools(), home, env: {}, mise: m.runner });
    expect(m.calls.filter((c) => c[0] === "current")).toEqual([
      ["current", "kubectl"],
      ["current", "ubi:vendor/their-cli"],
    ]);

    expect(m.calls.filter((c) => c[0] === "where")).toEqual([
      ["where", "kubectl@1.31.3"],
      ["where", "ubi:vendor/their-cli@0.9.1"],
    ]);

    expect(m.dir()).toBe(home);
  });

  it("marks a tool that installed but does not resolve as unavailable, naming it", async () => {
    const m = fakeMise((a) =>
      a[0] === "where" && a[1] === "kubectl@1.31.3"
        ? "mise ERROR kubectl@1.31.3 is not installed\nmise ERROR Version: 2026.10.18"
        : undefined,
    );

    const r = await installTools({ tools: tools(), home: homeDir(), env: {}, mise: m.runner });
    expect(r.statuses).toEqual([
      {
        name: "kubectl",
        version: "1.31.3",
        state: "unavailable",
        error: "kubectl@1.31.3 does not resolve: kubectl@1.31.3 is not installed",
      },
      { name: "their-cli", version: "0.9.1", state: "installed" },
    ]);
  });

  it("marks a tool that installed but has no active version as unavailable", async () => {
    const home = homeDir();
    const m = fakeMise();
    await installTools({ tools: tools(), home, env: {}, mise: m.runner });
    const { writeFileSync } = await import("node:fs");
    // A config that sets no version for the tool, as before the global config was written.
    writeFileSync(join(home, ".config/mise/config.toml"), "[tools]\n");
    const failed = await verifyTools({ tools: tools(), home, env: {}, mise: m.runner });
    expect(failed.map((s) => s.error)).toEqual([
      expect.stringContaining("kubectl@1.31.3 does not resolve: no version is active"),
      expect.stringContaining("their-cli@0.9.1 does not resolve: no version is active"),
    ]);
  });

  it("verifyTools returns only the tools that fail", async () => {
    const m = fakeMise((a) =>
      a[0] === "current" && a[1] === "kubectl" ? "not installed" : undefined,
    );

    const home = homeDir();
    await installTools({ tools: tools(), home, env: {}, mise: fakeMise().runner });
    const failed = await verifyTools({ tools: tools(), home, env: {}, mise: m.runner });
    expect(failed.map((s) => s.name)).toEqual(["kubectl"]);
  });

  it("does nothing without tools", async () => {
    const m = fakeMise();
    const r = await installTools({ tools: [], home: homeDir(), env: {}, mise: m.runner });
    expect(r.statuses).toEqual([]);
    expect(m.calls).toEqual([]);
  });

  it("renders deterministic toml", () => {
    expect(renderMiseToml(tools())).toBe(renderMiseToml(tools()));
  });
});
