import {
  RenderError,
  formatCatalogIssue,
  formatIssue,
  renderPerson,
  renderToDir,
} from "@outstaff/core";
import { isAbsolute, resolve } from "node:path";
import { loadCatalogs } from "../catalogs.js";
import { defineCommand } from "../define.js";
import { loadTeam } from "../load.js";
import { table } from "../table.js";
import type { Context } from "../types.js";

const size = (text: string) => Buffer.byteLength(text);

type Rendered = ReturnType<typeof renderPerson>;
type RenderedFile = { path: string; bytes: number; content: string };

function printErrors(ctx: Context, messages: string[]): void {
  for (const m of messages) {
    ctx.err(`error    ${m}\n`);
  }
}

/** --out as an absolute path; undefined when it was not given. */
function outDir(ctx: Context, out: string | undefined): string | undefined {
  if (out === undefined) {
    return undefined;
  }

  return isAbsolute(out) ? out : resolve(ctx.cwd, out);
}

/** Renders the person, writing the files below `target` when given, with each file's size. */
function renderFiles(
  input: Parameters<typeof renderPerson>[0],
  target: string | undefined,
  force: boolean | undefined,
): { result: Rendered; files: RenderedFile[] } {
  const result = target
    ? renderToDir({ ...input, out: target, ...(force ? { force } : {}) })
    : renderPerson(input);

  const files = [...result.files].map(([path, content]) => ({
    path,
    bytes: size(content),
    content,
  }));

  return { result, files };
}

function printText(
  ctx: Context,
  result: Rendered,
  files: RenderedFile[],
  target: string | undefined,
): void {
  ctx.out(
    `${table(
      ["FILE", "BYTES"],
      files.map((f) => [f.path, String(f.bytes)]),
    )}\n`,
  );

  for (const w of result.warnings) {
    ctx.err(`warning  ${w.message}\n`);
  }

  ctx.out(
    target
      ? `Wrote ${files.length} files to ${target}\n`
      : `${files.length} files (pass --out <dir> to write them)\n`,
  );
}

/** Prints why rendering or writing failed and returns the exit code; rethrows anything that is not an Error. */
function reportFailure(ctx: Context, e: unknown): number {
  if (e instanceof RenderError) {
    printErrors(ctx, e.issues.map(formatCatalogIssue));
    return 1;
  }

  if (e instanceof Error) {
    ctx.err(`error    ${e.message}\n`);
    return 1;
  }

  throw e;
}

export const render = defineCommand({
  name: "render",
  summary: "Render the working files of one person from the catalog.",
  description:
    "Renders a person's skills, references, templates and process documents from the stock catalog (the installed @outstaff/catalog package) and the team's ejected catalog (catalog.path, relative to the team file; same-named roles and documents replace stock ones). Without --out it lists the files with their sizes; with --out it writes them below that directory, refusing a non-empty directory unless --force is given.",
  args: "<handle>",
  options: [
    { flags: "--out <dir>", description: "Write the files below this directory." },
    { flags: "--force", description: "Write into a non-empty --out directory." },
  ],
  examples: [
    "ost render sam",
    "ost render sam --out ./work/sam",
    "ost render sam --out ./work/sam --force",
    "ost render sam --json",
  ],
  exitCodes: [
    "0: the files were listed or written",
    "1: the config or catalog could not be loaded, the person is unknown, rendering failed, or --out is not empty",
  ],
  async run(ctx, options, args) {
    const handle = args[0] ?? "";
    const { out, force } = options as { out?: string; force?: boolean };
    const loaded = await loadTeam(ctx, options);
    if (!loaded.ok) {
      printErrors(ctx, loaded.issues.map(formatIssue));
      return 1;
    }

    const found = loadCatalogs(ctx, loaded.config, loaded.source.dir);
    if (!found.ok) {
      printErrors(ctx, found.issues.map(formatCatalogIssue));
      return 1;
    }

    const input = {
      team: loaded.config,
      handle,
      catalog: found.catalogs.stock,
      ...(found.catalogs.ejected ? { ejected: found.catalogs.ejected } : {}),
    };

    try {
      const target = outDir(ctx, out);
      const { result, files } = renderFiles(input, target, force);
      if (options.json) {
        ctx.out(
          `${JSON.stringify(
            {
              handle,
              role: result.role,
              extends: result.extends,
              out: target ?? null,
              warnings: result.warnings,
              files,
            },
            null,
            2,
          )}\n`,
        );
      } else {
        printText(ctx, result, files, target);
      }

      return 0;
    } catch (e) {
      return reportFailure(ctx, e);
    }
  },
});
