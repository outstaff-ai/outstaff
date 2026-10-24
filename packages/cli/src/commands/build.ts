import { existsSync, readFileSync } from "node:fs";
import {
  RenderError,
  formatCatalogIssue,
  formatIssue,
  renderTeam,
  validateTeam,
} from "@outstaff/core";
import { join } from "node:path";
import { catalogIssue, loadCatalogs, roleRegistry } from "../catalogs.js";
import { defineCommand } from "../define.js";
import { hasConflictMarkers, tryIndex } from "../ejected.js";
import { loadTeam } from "../load.js";

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
      for (const i of loaded.issues) {
        ctx.err(`error    ${formatIssue(i)}\n`);
      }

      return 1;
    }

    const found = loadCatalogs(ctx, loaded.config, loaded.source.dir);
    if (!found.ok) {
      for (const i of found.issues) {
        ctx.err(`error    ${formatIssue(catalogIssue(i))}\n`);
      }

      return 1;
    }

    const report = validateTeam(loaded.config, {
      roles: roleRegistry(found.catalogs),
      adapters: new Map(),
    });

    let failed = false;
    for (const e of report.errors) {
      ctx.err(`error    ${formatIssue(loaded.locate(e))}\n`);
      failed = true;
    }

    for (const w of report.warnings) {
      ctx.err(`warning  ${formatIssue(loaded.locate(w))}\n`);
    }

    const dir = found.catalogs.ejected?.dir;
    const index = dir ? tryIndex(ctx, dir) : {};
    if (!index) {
      return 1;
    }

    const ejectedFiles = Object.keys(index);
    for (const p of ejectedFiles) {
      const file = join(dir ?? "", p);
      if (existsSync(file) && hasConflictMarkers(readFileSync(file, "utf8"))) {
        ctx.err(`error    ${file}: unresolved conflict markers from ost upgrade.\n`);
        failed = true;
      }
    }

    let people = 0;
    let files = 0;
    if (!failed) {
      try {
        const rendered = renderTeam({
          team: loaded.config,
          catalog: found.catalogs.stock,
          ...(found.catalogs.ejected ? { ejected: found.catalogs.ejected } : {}),
        });

        people = rendered.size;
        for (const r of rendered.values()) {
          files += r.files.size;
          for (const w of r.warnings) {
            ctx.err(`warning  ${w.message}\n`);
          }
        }
      } catch (e) {
        if (!(e instanceof RenderError)) {
          throw e;
        }

        for (const i of e.issues) {
          ctx.err(`error    ${formatCatalogIssue(i)}\n`);
        }

        failed = true;
      }
    }

    const summary = {
      ok: !failed,
      team: loaded.config.team.name,
      catalogVersion: loaded.config.catalog.version,
      ejectedFiles: ejectedFiles.length,
      people,
      files,
    };

    if (options.json) {
      ctx.out(`${JSON.stringify(summary, null, 2)}\n`);
    } else if (failed) {
      ctx.err("Build failed.\n");
    } else {
      ctx.out(
        `${summary.team}: catalog ${summary.catalogVersion}, ${ejectedFiles.length} ejected file${ejectedFiles.length === 1 ? "" : "s"}, ${people} ${people === 1 ? "person" : "people"} rendered (${files} files)\n`,
      );
    }

    return failed ? 1 : 0;
  },
});
