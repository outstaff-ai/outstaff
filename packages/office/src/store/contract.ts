import { afterEach, beforeEach, describe } from "vitest";
import { eventCases } from "./contract/events.js";
import { orderingCases } from "./contract/ordering.js";
import { pauseCases } from "./contract/pauses.js";
import { queueCases } from "./contract/queue.js";
import { recordCases } from "./contract/records.js";
import type { ContractContext, StoreHarness } from "./contract.types.js";
import type { OpenStoreOptions, Store } from "./types.js";

/** Runs the store contract against a fresh, isolated storage per test. */
export function storeContract(name: string, makeHarness: () => StoreHarness): void {
  describe(`store contract: ${name}`, () => {
    let h: StoreHarness;
    let store: Store;
    const open = async (opts?: OpenStoreOptions) => (store = await h.open(opts));
    const ctx: ContractContext = {
      get store() {
        return store;
      },
      get h() {
        return h;
      },
      open,
    };

    beforeEach(async () => {
      h = makeHarness();
      await open();
    });

    afterEach(async () => {
      await store.close().catch(() => undefined);
      await h.cleanup();
    });

    eventCases(ctx);
    queueCases(ctx);
    recordCases(ctx);
    orderingCases(ctx);
    pauseCases(ctx);
  });
}
