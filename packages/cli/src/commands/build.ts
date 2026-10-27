import { existsSync, readFileSync } from "node:fs";
import {
  RenderError,
  formatCatalogIssue,
  formatIssue,
  renderTeam,
  validateTeam,
  type TeamConfig,
} from "@outstaff/core";
import { join } from "node:path";
import { catalogIssue, loadCatalogs, roleRegistry } from "#/catalogs.js";
import { defineCommand } from "#/define.js";
import { tryIndex } from "#/ejected.js";
import { hasConflictMarkers } from "#/merge.js";
import { loadTeam } from "#/load.js";
import type { Context, Loaded, TeamCatalogs } from "#/types.js";

type LoadedTeam = Extract<Loaded, { ok: true }>;
type RenderCounts = { failed: boolean; people: number; files: number };
type BuildSummary = {
  ok: boolean;
  team: string;
  catalogVersion: string;
  ejectedFiles: number;
  people: number;
  files: number;
};

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** Prints the team's validation errors and warnings; true when there was an error. */
function reportValidation(ctx: Context, loaded: LoadedTeam, catalogs: TeamCatalogs): boolean {
  const report = validateTeam(loaded.config, {
    roles: roleRegistry(catalogs),
    adapters: new Map(),
  });

  printErrors(
    ctx,
    report.errors.map((e) => formatIssue(loaded.locate(e))),
  );

  for (const w of report.warnings) {
    ctx.err(`warning  ${formatIssue(loaded.locate(w))}\n`);
  }

  return report.errors.length > 0;
}

/** Prints every ejected file that still has conflict markers; true when there was one. */
function reportConflicts(ctx: Context, dir: string, paths: string[]): boolean {
  const conflicted = paths
    .map((p) => join(dir, p))
    .filter((file) => existsSync(file) && hasConflictMarkers(readFileSync(file, "utf8")));

  printErrors(
    ctx,
    conflicted.map((file) => `${file}: unresolved conflict markers from ost upgrade.`),
  );

  return conflicted.length > 0;
}

/** Renders every person, printing render warnings, or the render errors when it fails. */
function renderEveryone(ctx: Context, team: TeamConfig, catalogs: TeamCatalogs): RenderCounts {
  try {
    const rendered = renderTeam({
      team,
      catalog: catalogs.stock,
      ...(catalogs.ejected ? { ejected: catalogs.ejected } : {}),
    });

    let files = 0;
    for (const r of rendered.values()) {
      files += r.files.size;
      for (const w of r.warnings) {
        ctx.err(`warning  ${w.message}\n`);
      }
    }

    return { failed: false, people: rendered.size, files };
  } catch (e) {
    if (!(e instanceof RenderError)) {
      throw e;
    }

    printErrors(ctx, e.issues.map(formatCatalogIssue));

    return { failed: true, people: 0, files: 0 };
  }
}

/** Checks and renders the loaded team; undefined when the ejected index cannot be read. */
function buildTeam(
  ctx: Context,
  loaded: LoadedTeam,
  catalogs: TeamCatalogs,
): (RenderCounts & { ejectedFiles: number }) | undefined {
  const invalid = reportValidation(ctx, loaded, catalogs);
  const dir = catalogs.ejected?.dir ?? "";
  const index = dir ? tryIndex(ctx, dir) : {};
  if (!index) {
    return undefined;
  }

  const ejectedFiles = Object.keys(index);
  const conflicted = reportConflicts(ctx, dir, ejectedFiles);
  const rendered =
    invalid || conflicted
      ? { failed: true, people: 0, files: 0 }
      : renderEveryone(ctx, loaded.config, catalogs);

  return { ...rendered, ejectedFiles: ejectedFiles.length };
}

function printErrors(ctx: Context, messages: string[]): void {
  for (const m of messages) {
    ctx.err(`error    ${m}\n`);
  }
}

function printSummary(ctx: Context, summary: BuildSummary): void {
  if (!summary.ok) {
    ctx.err("Build failed.\n");
    return;
  }

  const { team, catalogVersion, ejectedFiles, people, files } = summary;
  ctx.out(
    `${team}: catalog ${catalogVersion}, ${ejectedFiles} ejected ${plural(ejectedFiles, "file", "files")}, ${people} ${plural(people, "person", "people")} rendered (${files} files)\n`,
  );
}

export const build = defineCommand({
  name: "build",
  summary: "Validate the team and render every person strictly; for client image builds.",
  description:
    "Checks the team config, loads the stock and ejected catalogs, rejects ejected files that still contain conflict markers from ost upgrade, and renders every person's working files. Fails on any error, so a broken customization stops the image build. Intended for a client Dockerfile: FROM ghcr.io/outstaff-ai/agent:<version>, COPY .outstaff /opt/outstaff/team/.outstaff, RUN ost build.",
  options: [],
  examples: ["ost build", "ost build --team /opt/outstaff/team"],
  exitCodes: ["0: the team validates and every person renders", "1: any error"],
  async run(ctx, options) {
    const loaded = await loadTeam(ctx, options);
    if (!loaded.ok) {
      printErrors(ctx, loaded.issues.map(formatIssue));
      return 1;
    }

    const found = loadCatalogs(ctx, loaded.config, loaded.source.dir);
    if (!found.ok) {
      printErrors(
        ctx,
        found.issues.map((i) => formatIssue(catalogIssue(i))),
      );

      return 1;
    }

    const result = buildTeam(ctx, loaded, found.catalogs);
    if (!result) {
      return 1;
    }

    const summary = {
      ok: !result.failed,
      team: loaded.config.team.name,
      catalogVersion: loaded.config.catalog.version,
      ejectedFiles: result.ejectedFiles,
      people: result.people,
      files: result.files,
    };

    if (options.json) {
      ctx.out(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      printSummary(ctx, summary);
    }

    return result.failed ? 1 : 0;
  },
});
