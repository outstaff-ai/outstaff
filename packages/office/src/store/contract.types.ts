import type { OpenStoreOptions, Store } from "./types.js";

export interface StoreHarness {
  /** False when data does not survive close() (in-memory). */
  persistent: boolean;

  /** Opens a store on this harness's storage, running migrations. Can be called again after close(). */
  open(opts?: OpenStoreOptions): Promise<Store>;

  /** Destroys the underlying storage (file, schema), as if the store were lost. */
  lose(): Promise<void>;

  /** Removes everything the harness created. */
  cleanup(): Promise<void>;
}

/** What the contract cases read while they run: the store and harness of the current test. */
export interface ContractContext {
  readonly store: Store;
  readonly h: StoreHarness;

  /** Opens the store again on the same storage; `store` is then the new one. */
  open(opts?: OpenStoreOptions): Promise<Store>;
}
