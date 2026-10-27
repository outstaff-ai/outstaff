import type { TestContext } from "vitest";
import type { Capability } from "../types.js";
import type { RepoRef, Vcs } from "../ports/index.js";
import type { VcsSeed } from "./seeds.js";

/** What an adapter's test hands to a contract kit. */
export interface ContractSetup<Subject, Seed> {
  subject: Subject;

  /** Everything optional: the kit skips the cases it cannot seed. */
  seed: Partial<Seed>;

  /** The capabilities the adapter declares; gated cases only run when present. */
  capabilities: readonly Capability[];
  cleanup?(): Promise<void>;
}

export type ContractSetupFn<Subject, Seed> = () => Promise<ContractSetup<Subject, Seed>>;

export type VcsSetup = ContractSetup<Vcs, VcsSeed>;

/** What each area of the vcs contract kit gets: the current setup, and its seeded repository (or a skip). */
export interface VcsCases {
  get: () => VcsSetup;
  repoOf: (t: TestContext, s: VcsSetup) => RepoRef;
}
