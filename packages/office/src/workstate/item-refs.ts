import { inferRefs } from "#/refs/index.js";
import type { Store } from "#/store/index.js";
import type { PrRecord } from "./types.js";

/** Records on the items of a pull request and of its ticket that the two belong together, once they do. */
export async function inferTicketRefs(
  store: Store,
  key: string,
  rec: PrRecord,
  prev?: PrRecord,
): Promise<void> {
  if (!rec.ticket || rec.ticket === prev?.ticket) {
    return;
  }

  const ticket = { type: "ticket" as const, ref: rec.ticket };
  await inferRefs(store, ticket, { type: "pr", ref: key, url: rec.url }, "workstate:implements");
  await inferRefs(store, { type: "pr", ref: key }, ticket, "workstate:implements");
}

/** Records on the items of a stacked pull request the pull request it is based on. */
export async function inferStackRefs(store: Store, key: string, base: string): Promise<void> {
  await inferRefs(
    store,
    { type: "pr", ref: key },
    { type: "pr", ref: base },
    "workstate:stacked_on",
  );
}
