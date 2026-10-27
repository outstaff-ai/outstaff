import { policyOn, type TeamConfig } from "@outstaff/core";
import type { Store, WorkItem } from "./store/types.js";
import type { PrRecord, WorkState } from "./workstate/index.js";

// The requester of the item's ticket, else the first human (as the workflow's own fallback does).
export function requesterChat(deps: {
  store: Store;
  workState: WorkState;
  team: Pick<TeamConfig, "humans" | "policies">;
}) {
  const { store, workState, team } = deps;
  return async (item: WorkItem): Promise<string | undefined> => {
    const ticket =
      item.subject?.type === "ticket"
        ? item.subject.ref
        : item.subject?.type === "pr"
          ? ((await store.getSubject("pr", item.subject.ref))?.data as PrRecord | undefined)?.ticket
          : undefined;

    if (!ticket) {
      return undefined;
    }

    const asked = workState.ticket(ticket)?.requester;
    const human = asked
      ? team.humans?.find(
          (h) => h.identities.tracker === asked || h.identities.vcs === asked || h.name === asked,
        )
      : policyOn(team.policies, "hand_back.fallback")
        ? team.humans?.[0]
        : undefined;

    return human?.identities.chat;
  };
}
