import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { envSecretSource, type SecretSource, type TeamConfig } from "@outstaff/core";
import type { Context } from "../../types.js";
import type { Scope } from "../types.js";
import type { Configured, DeriveReport } from "./types.js";

/** Prefixes of the GitHub App key sets, whose downloaded `<slug>.<date>.private-key.pem` can be picked up. */
const APP_PREFIXES: Record<Scope, string[]> = {
  person: ["GH_APP_", "GH_OFFICE_APP_"],
  office: ["GH_OFFICE_APP_"],
};

function findDownloadedKey(downloads: string, slug: string): string | undefined {
  if (!existsSync(downloads)) {
    return undefined;
  }

  const wanted = `${slug.toLowerCase()}.`;
  return readdirSync(downloads)
    .filter((f) => f.toLowerCase().startsWith(wanted) && f.toLowerCase().endsWith(".pem"))
    .map((f) => join(downloads, f))
    .toSorted((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

function writeSecret(dir: string, key: string, value: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, key);
  writeFileSync(file, `${value}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export async function runDerive(
  ctx: Context,
  team: TeamConfig,
  found: Configured[],
  scope: Scope,
  person: TeamConfig["people"][number] | undefined,
  dir: string,
  yes: boolean,
): Promise<DeriveReport> {
  const report: DeriveReport = { written: [], warnings: [] };
  const secrets: SecretSource = envSecretSource(ctx.env, dir);

  // A just-downloaded key is moved first so the lookups below can use it.
  const downloads = join(ctx.home ?? homedir(), "Downloads");
  for (const prefix of APP_PREFIXES[scope]) {
    const slug = secrets.get(`${prefix}SLUG`);
    if (!slug || secrets.get(`${prefix}PRIVATE_KEY`) || secrets.get(`${prefix}PRIVATE_KEY_FILE`)) {
      continue;
    }

    const pem = findDownloadedKey(downloads, slug);
    if (!pem) {
      continue;
    }

    const ask = `Move ${pem} to ${join(dir, `${prefix}PRIVATE_KEY`)}?`;
    const ok = yes || (ctx.confirm ? await ctx.confirm(ask) : false);
    if (!ok) {
      report.warnings.push(
        `Found ${pem} for the App ${slug}; run again with --yes to move it into the secrets directory.`,
      );

      continue;
    }

    writeSecret(dir, `${prefix}PRIVATE_KEY`, readFileSync(pem, "utf8").trim());
    unlinkSync(pem);
    report.written.push(`${prefix}PRIVATE_KEY`);
  }

  const fetchImpl = ctx.fetch ?? fetch;
  const seen = new Set<unknown>();
  for (const { def, options } of found) {
    if (!def.derive) {
      continue;
    }

    const allowed = new Set(
      def
        .secrets(scope, person ? { team, person } : undefined)
        .filter((s) => s.derivable)
        .map((s) => s.key),
    );

    let values: Record<string, string>;
    try {
      values = await def.derive(secrets, {
        team,
        scope,
        options,
        ...(person ? { person } : {}),
        fetch: fetchImpl,
        now: ctx.now ?? (() => new Date()),
        warn: (m) => report.warnings.push(`${def.name}: ${m}`),
      });
    } catch (e) {
      report.warnings.push(`${def.name}: ${(e as Error).message}`);
      continue;
    }

    for (const [key, value] of Object.entries(values)) {
      if (!allowed.has(key)) {
        report.warnings.push(
          `${def.name}: ignored ${key}, which it does not declare as derivable.`,
        );
      } else if (!seen.has(key)) {
        seen.add(key);
        writeSecret(dir, key, value);
        report.written.push(key);
      }
    }
  }

  return report;
}
