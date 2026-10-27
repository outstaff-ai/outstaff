import type { ItemRefType, Store } from "#/store/types.js";

/**
 * What the work state worked out about one reference, recorded on every item that refers to it: a pull request of a
 * ticket, the ticket of a pull request, the pull request a stack is based on. An item that ended keeps the record
 * too: the pull request still implements the ticket the item was about.
 */
export async function inferRefs(
  store: Pick<Store, "findItemRefs" | "addItemRefs">,
  from: { type: ItemRefType; ref: string },
  to: { type: ItemRefType; ref: string; url?: string | undefined },
  source: string,
): Promise<void> {
  const items = new Set((await store.findItemRefs(from.type, from.ref)).map((r) => r.workItemId));
  for (const id of items) {
    await store.addItemRefs(id, [{ ...to, role: "inferred", source }]);
  }
}
