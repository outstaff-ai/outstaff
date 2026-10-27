import { policyOn, type TeamConfig } from "@outstaff/core";
import { itemTicket } from "./item-ticket.js";
import type { Store, WorkItem } from "./store/types.js";
import type { WorkState } from "./workstate/index.js";

type Team = Pick<TeamConfig, "humans" | "policies">;

/** The human who asked for the ticket, by any of their names; without one, the first human if the policy says so. */
function requesterHuman(team: Team, asked: string | undefined) {
  if (asked) {
    return team.humans?.find(
      (h) => h.identities.tracker === asked || h.identities.vcs === asked || h.name === asked,
    );
  }

  return policyOn(team.policies, "hand_back.fallback") ? team.humans?.[0] : undefined;
}

// The requester of the item's ticket, else the first human (as the workflow's own fallback does).
export function requesterChat(deps: { store: Store; workState: WorkState; team: Team }) {
  const { store, workState, team } = deps;
  return async (item: WorkItem): Promise<string | undefined> => {
    const ticket = await itemTicket(store, item);
    if (!ticket) {
      return undefined;
    }

    return requesterHuman(team, workState.ticket(ticket)?.requester)?.identities.chat;
  };
}
