import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderReplayReport } from "#/pipeline/replay/report.js";
import { runReplay } from "#/pipeline/replay/replay.js";
import { acmeSetup, acmeTeam } from "./acme.js";
import { ACME_REPLAY } from "./fixture/index.js";

const GOLDEN = fileURLToPath(new URL("./__golden__", import.meta.url));
const FILE = join(GOLDEN, "acme-replay.md");

describe("the acme replay", () => {
  const result = runReplay(ACME_REPLAY, acmeSetup());

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

  it("with policies.feedback.from humans, the teammate's review wakes no one and nothing else changes", () => {
    const team = acmeTeam();
    const humansOnly = runReplay(
      ACME_REPLAY,
      acmeSetup({
        ...team,
        policies: { ...team.policies!, feedback: { ...team.policies!.feedback, from: "humans" } },
      }),
    );

    const decided = (r: typeof result) =>
      new Map(r.scenarios.flatMap((s) => s.rows).map((row) => [row.event.id, row.decisions]));

    const all = decided(result);
    const only = decided(humansOnly);
    const changed = [...all.keys()].filter(
      (id) => JSON.stringify(all.get(id)) !== JSON.stringify(only.get(id)),
    );

    expect(changed).toEqual(["replay:s11-agent-review"]);
    expect(only.get("replay:s11-agent-review")).toEqual(["(drop: no policy matched)"]);
  });

  it("has no stale golden files", () => {
    expect(readdirSync(GOLDEN)).toEqual(["acme-replay.md"]);
  });
});
