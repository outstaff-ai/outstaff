import type { DoctorCheck, TeamConfig } from "@outstaff/core";
import type { AgentEnv } from "#/verbs/types.js";

/**
 * Whether the agent can make the acts the office sends it: they are made with its own tracker port. Its a Plan offers
 * no cheap way to ask whether a member may write, so this checks that the port started; `ost doctor` checks the key
 * and that it belongs to the person's `identities.tracker`.
 */
export function actsCheck(
  team: Pick<TeamConfig, "integrations">,
  ports: Pick<AgentEnv, "tracker" | "unavailable">,
): DoctorCheck[] {
  if (!team.integrations.tracker) {
    return [];
  }

  if (ports.tracker) {
    return [
      {
        name: "Tracker acts",
        status: "ok",
        detail:
          "The tracker port started: the acts the office sends are made with this person's own account.",
      },
    ];
  }

  return [
    {
      name: "Tracker acts",
      status: "fail",
      detail: `The tracker port did not start (${ports.unavailable?.tracker ?? "no reason given"}), so every act the office sends this agent fails.`,
      fix: "Run `ost doctor` for the person to check the tracker integration and its secrets, then restart the agent.",
    },
  ];
}
