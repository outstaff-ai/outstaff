import type { Catalog, CatalogRole } from "../catalog/types.js";
import type { TeamConfig } from "../config/types.js";

export type RenderWarning = { code: string; message: string };

export type RenderedWorkdir = {
  /** Relative path (forward slashes) to text; keys are sorted. */
  files: Map<string, string>;
  role: string;

  /** Extra roles whose skills were rendered, in render order. */
  extends: string[];

  /** The role's permission profile; the runtime adapter compiles it. */
  profile: CatalogRole["permissions"];
  warnings: RenderWarning[];
};

export type RenderPersonOptions = {
  team: TeamConfig;
  handle: string;
  catalog: Catalog;

  /** Client's `.outstaff/catalog/`; same-named roles and documents replace stock ones. */
  ejected?: Catalog;

  /**
   * Absolute directory the files are written to. When set, every `process/`, `references/` and `templates/`
   * document path in the text becomes absolute below it, since agents run in other directories.
   */
  workdir?: string;

  /** URL templates for the `links` placeholders. */
  links?: Record<string, string>;
};

export type RenderTeamOptions = Omit<RenderPersonOptions, "handle">;

export type RenderToDirOptions = RenderPersonOptions & {
  out: string;

  /** Write into a non-empty directory. Existing files with the same path are overwritten. */
  force?: boolean;
};
