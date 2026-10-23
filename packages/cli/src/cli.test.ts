import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const cli = new URL("./cli.ts", import.meta.url).pathname;
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const run = (...args: string[]) =>
  execFileSync(process.execPath, [cli, ...args], { encoding: "utf8" }).trim();

describe("outstaff cli", () => {
  it("prints the package version for --version", () => {
    expect(run("--version")).toBe(pkg.version);
  });

  it("prints usage otherwise", () => {
    expect(run()).toMatch(/^Usage: outstaff/);
  });
});
