import { formatIssue, validateTeam, type ConfigWarning, type LocatedIssue } from "@outstaff/core";
import { catalogIssue, loadCatalogs, roleRegistry } from "../catalogs.js";
import { defineCommand } from "../define.js";
import { issueJson, loadTeam } from "../load.js";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const validate = defineCommand({
  name: "validate",
  summary: "Check the team config for errors and warnings.",
  description:
    "Loads the team file, checks it against the schema and cross-field rules, and lists every problem with its file, line and column. Warnings describe what will not work as written. Roles are checked against the stock catalog plus the team's ejected catalog (catalog.path); adapter names are not checked yet and are accepted as written.",
  options: [],
  examples: ["ost validate", "ost validate --team ../acme-team", "ost validate --json"],
  exitCodes: [
    "0: no errors (warnings are allowed)",
    "1: the config has errors or could not be loaded",
  ],
  async run(ctx, options) {
    const loaded = await loadTeam(ctx, options);
    let errors: LocatedIssue[];
    let warnings: (LocatedIssue & { consequence: string })[] = [];

    if (!loaded.ok) {
      errors = loaded.issues;
    } else {
      const found = loadCatalogs(ctx, loaded.config, loaded.source.dir);
      if (!found.ok) {
        errors = found.issues.map(catalogIssue);
      } else {
        const report = validateTeam(loaded.config, {
          roles: roleRegistry(found.catalogs),
          adapters: new Map(),
        });

        errors = report.errors.map(loaded.locate);
        warnings = report.warnings.map((w: ConfigWarning) => ({
          ...loaded.locate(w),
          consequence: w.consequence,
        }));
      }
    }

    const ok = errors.length === 0;
    if (options.json) {
      ctx.out(
        `${JSON.stringify(
          {
            ok,
            file: loaded.ok ? loaded.source.file : null,
            errors: errors.map(issueJson),
            warnings: warnings.map(issueJson),
          },
          null,
          2,
        )}\n`,
      );

      return ok ? 0 : 1;
    }

    for (const e of errors) {
      ctx.out(`error    ${formatIssue(e)}\n`);
    }

    for (const w of warnings) {
      ctx.out(`warning  ${formatIssue(w)}\n         Consequence: ${w.consequence}\n`);
    }

    const name = loaded.ok ? `${loaded.config.team.name}: ` : "";
    ctx.out(`${name}${plural(errors.length, "error")}, ${plural(warnings.length, "warning")}\n`);
    return ok ? 0 : 1;
  },
});
