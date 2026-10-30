import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseTeamConfig, parseYaml } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { formatReplay, harnessEvent, replayPolicy } from "#/harness.js";
import { loadCustomPolicies } from "#/load.js";
import { OPTS } from "./support.js";

/** The acme example team's folder, where its team file and its custom policy are. */
const ACME = fileURLToPath(new URL("../../../../examples/acme/.outstaff/", import.meta.url));

async function acmePolicies() {
  const parsed = parseTeamConfig(parseYaml(readFileSync(`${ACME}team.yaml`, "utf8")).value);
  if (!parsed.ok) {
    throw new Error("the acme example does not parse");
  }

  return loadCustomPolicies(parsed.config.policies!.custom!, ACME);
}

const ticket = (labels: string[] = []) => ({
  tickets: {
    "ACME-7": {
      status: "ready" as const,
      assignee: { id: "sam", kind: "agent" as const },
      labels,
    },
  },
});

describe("the acme team's release_freeze policy", () => {
  it("loads from the team's repository, with its settings", async () => {
    const loaded = await acmePolicies();
    expect(loaded.issues).toEqual([]);
    expect(loaded.policies).toMatchObject([
      { id: "release_freeze", settings: { until: "2026-12-01T00:00:00Z", label: "hotfix" } },
    ]);
  });

  it("holds new work during the freeze, lets a hotfix through, and stops when the freeze ends", async () => {
    const [freeze] = (await acmePolicies()).policies;
    const assigned = (at: string) =>
      harnessEvent("ticket.assigned", { id: `tracker:${at}`, at, subject: { ticket: "ACME-7" } });

    const results = replayPolicy(
      freeze!,
      [
        { event: assigned("2026-11-20T10:00:00.000Z"), world: ticket() },
        { event: assigned("2026-11-20T11:00:00.000Z"), world: ticket(["hotfix"]) },
        { event: assigned("2026-12-02T10:00:00.000Z"), world: ticket() },
        { event: assigned("2026-11-20T12:00:00.000Z") },
      ],
      OPTS,
    );

    expect(formatReplay(results)).toBe(
      [
        "ticket.assigned tracker:2026-11-20T10:00:00.000Z: matched (assignee is agent, wanted agent)",
        "  suppress waking sam: release freeze until 2026-12-01T00:00:00Z: new work waits",
        "ticket.assigned tracker:2026-11-20T11:00:00.000Z: matched (assignee is agent, wanted agent)",
        "  drop: ACME-7 is labelled hotfix: the freeze lets it through",
        "ticket.assigned tracker:2026-12-02T10:00:00.000Z: matched (assignee is agent, wanted agent)",
        "ticket.assigned tracker:2026-11-20T12:00:00.000Z: no (assignee is none, wanted agent)",
      ].join("\n"),
    );

    expect(results[0]!.proposals).toEqual([
      {
        type: "suppress",
        person: "sam",
        subject: { type: "ticket", ref: "ACME-7" },
        reason: "release freeze until 2026-12-01T00:00:00Z: new work waits",
      },
    ]);
  });
});
