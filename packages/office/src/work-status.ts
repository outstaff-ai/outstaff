import type { WorkState } from "@outstaff/protocol";
import type { WorkSource } from "./protocol/source.types.js";
import type { Store } from "./store/types.js";

/** The state of the items an agent asks about. Only the person's own items show their status. */
export function workStatus(store: Pick<Store, "getItem">): Pick<WorkSource, "status"> {
  const stateOf = async (person: string, workItemId: string): Promise<WorkState> => {
    const item = await store.getItem(workItemId);
    if (!item) {
      return { workItemId, state: "unknown" };
    }

    return { workItemId, state: item.person === person ? item.status : "not_yours" };
  };

  return {
    status: (person, workItemIds) => Promise.all(workItemIds.map((id) => stateOf(person, id))),
  };
}
