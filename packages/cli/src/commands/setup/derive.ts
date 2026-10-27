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
import type { Context } from "#/types.js";
import type { Scope } from "#/commands/types.js";
import type { Configured, DeriveReport, DeriveRun } from "./types.js";

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

const hasPrivateKey = (secrets: SecretSource, prefix: string): boolean =>
  Boolean(secrets.get(`${prefix}PRIVATE_KEY`) || secrets.get(`${prefix}PRIVATE_KEY_FILE`));

/** Whether a found key may be moved: --yes, or a confirmation in a terminal. */
async function mayMove(run: DeriveRun, pem: string, prefix: string): Promise<boolean> {
  if (run.yes) {
    return true;
  }

  const ask = `Move ${pem} to ${join(run.dir, `${prefix}PRIVATE_KEY`)}?`;
  return run.ctx.confirm ? run.ctx.confirm(ask) : false;
}

/** Moves a just-downloaded private key of the App with this prefix into the secrets directory. */
async function moveDownloadedKey(run: DeriveRun, downloads: string, prefix: string): Promise<void> {
  const slug = run.secrets.get(`${prefix}SLUG`);
  if (!slug || hasPrivateKey(run.secrets, prefix)) {
    return;
  }

  const pem = findDownloadedKey(downloads, slug);
  if (!pem) {
    return;
  }

  if (!(await mayMove(run, pem, prefix))) {
    run.report.warnings.push(
      `Found ${pem} for the App ${slug}; run again with --yes to move it into the secrets directory.`,
    );

    return;
  }

  writeSecret(run.dir, `${prefix}PRIVATE_KEY`, readFileSync(pem, "utf8").trim());
  unlinkSync(pem);
  run.report.written.push(`${prefix}PRIVATE_KEY`);
}

/** The keys an adapter declares as derivable for this scope. */
function derivableKeys(run: DeriveRun, def: Configured["def"]): Set<string> {
  const { team, person } = run;
  return new Set(
    def
      .secrets(run.scope, person ? { team, person } : undefined)
      .filter((s) => s.derivable)
      .map((s) => s.key),
  );
}

/** What an adapter derives; undefined when it derives nothing, with a warning when it fails. */
async function deriveWith(
  run: DeriveRun,
  { def, options }: Configured,
): Promise<Record<string, string> | undefined> {
  if (!def.derive) {
    return undefined;
  }

  const { ctx, team, scope, person, report } = run;
  try {
    return await def.derive(run.secrets, {
      team,
      scope,
      options,
      ...(person ? { person } : {}),
      fetch: ctx.fetch ?? fetch,
      now: ctx.now ?? (() => new Date()),
      warn: (m) => report.warnings.push(`${def.name}: ${m}`),
    });
  } catch (e) {
    report.warnings.push(`${def.name}: ${(e as Error).message}`);
    return undefined;
  }
}

/** Writes the derived values the adapter declares, once per key; warns about the others. */
function keepDerived(
  run: DeriveRun,
  def: Configured["def"],
  allowed: Set<string>,
  values: Record<string, string>,
  seen: Set<string>,
): void {
  for (const [key, value] of Object.entries(values)) {
    if (!allowed.has(key)) {
      run.report.warnings.push(
        `${def.name}: ignored ${key}, which it does not declare as derivable.`,
      );
    } else if (!seen.has(key)) {
      seen.add(key);
      writeSecret(run.dir, key, value);
      run.report.written.push(key);
    }
  }
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
  const run: DeriveRun = { ctx, team, scope, person, dir, yes, secrets, report };

  // A just-downloaded key is moved first so the lookups below can use it.
  const downloads = join(ctx.home ?? homedir(), "Downloads");
  for (const prefix of APP_PREFIXES[scope]) {
    await moveDownloadedKey(run, downloads, prefix);
  }

  const seen = new Set<string>();
  for (const configured of found) {
    if (!configured.def.derive) {
      continue;
    }

    const allowed = derivableKeys(run, configured.def);
    const values = await deriveWith(run, configured);
    if (values) {
      keepDerived(run, configured.def, allowed, values, seen);
    }
  }

  return report;
}
