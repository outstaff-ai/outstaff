import type { WorkState } from "@outstaff/protocol";

/** A known folder of the agent's home that can grow large. */
export interface HomeFolder {
  /** What it is, for a person: `worktrees`, `pnpm store`, ... */
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
  worktreesDir: string;

  /** The items that have a worktree, and the office's state of each. */
  held: () => string[];
  workStatus: (ids: string[]) => Promise<WorkState[]>;

  /** Defaults to a walk of the folders bounded at {@link MAX_ENTRIES} entries. */
  measure?: MeasureFolders;
}

/** What fills the agent's home. */
export interface HomeSpace {
  /** The known folders, in the order they are measured: a store before the worktrees that link into it. */
  folders(): HomeFolder[];

  /**
   * The largest known folders with their sizes, largest first, worktrees with how many are blocked or waiting; for the
   * doctor's fix line. Undefined when nothing could be measured.
   */
  breakdown(): Promise<string | undefined>;
}
