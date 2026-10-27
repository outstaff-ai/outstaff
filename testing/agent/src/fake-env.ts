import { parseTeamConfig, parseYaml, type TeamConfig } from "@outstaff/core";
import { createFakeKnowledge, createFakeTracker, createFakeVcs } from "@outstaff/core/fakes";
import { readFileSync } from "node:fs";
import { createFakeOffice, type AgentEnv } from "@outstaff/agent";

export const acmeTeam = (): TeamConfig => {
  const text = readFileSync(
    new URL("../../../examples/acme/.outstaff/team.yaml", import.meta.url),
    "utf8",
  );

  const parsed = parseTeamConfig(parseYaml(text).value);
  if (!parsed.ok) {
    throw new Error("acme team does not parse");
  }

  return parsed.config;
};

/** An environment of fakes for the acme team, acting as sam. Pass `false` to leave a port out. */
export function fakeEnv(opts: { tracker?: boolean; knowledge?: boolean; office?: boolean } = {}) {
  const tracker = createFakeTracker({ keyPrefix: "SHOP" });
  const knowledge = createFakeKnowledge();
  const vcs = createFakeVcs();
  const office = createFakeOffice({
    items: [{ id: "w1", title: "Fix checkout", status: "active", ticketKey: "SHOP-1" }],
    team: [{ handle: "mira", name: "Mira Okafor", role: "architect", status: "idle" }],
    answer: (to) => (to === "mira" ? "Yes." : undefined),
  });

  const env: AgentEnv = {
    person: "sam",
    team: acmeTeam(),
    vcs,
    ...(opts.tracker === false ? {} : { tracker }),
    ...(opts.knowledge === false ? {} : { knowledge }),
    ...(opts.office === false ? {} : { office }),
  };

  return { env, tracker, knowledge, vcs, office };
}
