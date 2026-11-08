import type { WorkState } from "@outstaff/protocol";

/** A folder of the agent's home, as the breakdown names it. */
export interface HomeFolder {
  /** What it is, for a person: `worktrees`, or its path with `~` for the home (`~/.cache/pnpm`). */
  name: string;
  path: string;
}

/** A folder and the space it takes; `capped` when the walk stopped at its limit, so the size is a lower bound. */
export interface MeasuredFolder extends HomeFolder {
  bytes: number;
  capped: boolean;
}

/** Measures folders in one pass, counting a file hard-linked into several of them once, in the first. */
export type MeasureFolders = (folders: HomeFolder[]) => Promise<MeasuredFolder[]>;

export interface HomeSpaceOptions {
  home: string;
  env: NodeJS.ProcessEnv;

  /** Named `worktrees` in the breakdown, with its items. */
  worktreesDir: string;

  /** The items that have a worktree, and the office's state of each. */
  held: () => string[];
  workStatus: (ids: string[]) => Promise<WorkState[]>;

  /** Defaults to a walk of the folders bounded at {@link MAX_ENTRIES} entries. */
  measure?: MeasureFolders;
}

/** What fills the agent's home. */
export interface HomeSpace {
  /**
   * The home's entries, with the cache and data homes split into theirs, in the order they are measured: the cache and
   * data homes' first, the worktrees last, so a file a store hard-links into a worktree counts in the store.
   */
  folders(): Promise<HomeFolder[]>;

  /**
   * The five largest folders with their sizes, largest first, the worktrees with how many items have one and
   * how many of those are blocked or waiting; for the doctor's fix line. Undefined when nothing could be measured.
   */
  breakdown(): Promise<string | undefined>;
}
