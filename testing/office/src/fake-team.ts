import { parseTeamConfig, type TeamConfig } from "@outstaff/core";

/** A small valid team for the protocol server to hand agents in their `welcome`. */
export function fakeTeam(): TeamConfig {
  const result = parseTeamConfig({
    version: 1,
    team: { name: "acme" },
    catalog: { version: "1.0.0" },
    repos: [{ name: "app", url: "git.acme.example/acme/app", kind: "primary" }],
    people: [
      { handle: "sam", name: "Sam", role: "developer" },
      { handle: "mira", name: "Mira", role: "architect" },
    ],
    integrations: {
      chat: { adapter: "fake" },
      vcs: { adapter: "fake" },
      runtime: { adapter: "fake" },
    },
  });

  if (!result.ok) {
    throw new Error(JSON.stringify(result.issues));
  }

  return result.config;
}
