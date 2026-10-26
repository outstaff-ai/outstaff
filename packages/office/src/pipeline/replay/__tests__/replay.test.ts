import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderReplayReport } from "../report.js";
import { runReplay } from "../replay.js";
import { acmeSetup } from "./acme.js";
import { ACME_REPLAY } from "./fixture/index.js";

const GOLDEN = fileURLToPath(new URL("./__golden__", import.meta.url));
const FILE = join(GOLDEN, "acme-replay.md");

describe("the acme replay", () => {
  const result = runReplay(ACME_REPLAY, acmeSetup());

  it("explains every difference between today's engine and the pipeline, and nothing else", () => {
    expect(result.problems).toEqual([]);
  });

  it("covers about fifty events", () => {
    const rows = result.scenarios.flatMap((s) => s.rows);
    expect(rows.length).toBeGreaterThanOrEqual(45);
    expect(new Set(rows.map((r) => r.event.id)).size).toBe(rows.length);
  });

  it("matches the golden report", () => {
    const actual = renderReplayReport(result);
    if (process.env["UPDATE_GOLDEN"] === "1") {
      mkdirSync(GOLDEN, { recursive: true });
      writeFileSync(FILE, actual);
    }

    expect(existsSync(FILE), `missing golden ${FILE}; run with UPDATE_GOLDEN=1`).toBe(true);
    expect(actual).toBe(readFileSync(FILE, "utf8"));
  });

  it("has no stale golden files", () => {
    expect(readdirSync(GOLDEN)).toEqual(["acme-replay.md"]);
  });
});
