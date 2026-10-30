import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { policyProblems } from "./define.js";
import type { CustomPolicyEntry, LoadedPolicies } from "./load.types.js";
import type { ConfiguredPolicy, Policy } from "./policy.types.js";

/** An import fails only with an Error: a module not found, or one that does not parse or throws. */
const message = (error: unknown) => (error as Error).message;

/** Where a `package` entry is: installed for the team's repository, else for the office itself. */
function packageUrl(name: string, dir: string): string {
  try {
    return pathToFileURL(createRequire(join(dir, "package.json")).resolve(name)).href;
  } catch {
    return name;
  }
}

const urlOf = (entry: CustomPolicyEntry, dir: string): string =>
  "module" in entry
    ? pathToFileURL(isAbsolute(entry.module) ? entry.module : resolve(dir, entry.module)).href
    : packageUrl(entry.package, dir);

/** The policies a module exports: `policy`, or a list as `policies`. */
function exported(mod: Record<string, unknown>): unknown[] | undefined {
  if (mod["policy"] !== undefined) {
    return [mod["policy"]];
  }

  return Array.isArray(mod["policies"]) ? mod["policies"] : undefined;
}

/**
 * Loads the team's custom policies (`policies.custom`): each entry a module of the team's repository, relative to the
 * team file's folder `dir`, or an npm package. A module exports `policy` (or a list as `policies`); each is checked
 * against the SDK's schema. Custom policies run in the office process, as trusted as the team's repository.
 */
export async function loadCustomPolicies(
  entries: readonly CustomPolicyEntry[],
  dir: string,
): Promise<LoadedPolicies> {
  const loaded: LoadedPolicies = { policies: [], issues: [] };
  for (const [index, entry] of entries.entries()) {
    const name = "module" in entry ? entry.module : entry.package;
    const issue = (text: string) => loaded.issues.push({ index, message: `${name}: ${text}` });
    let mod: Record<string, unknown>;
    try {
      mod = (await import(urlOf(entry, dir))) as Record<string, unknown>;
    } catch (error) {
      issue(`cannot be loaded: ${message(error)}`);
      continue;
    }

    const found = exported(mod);
    if (!found) {
      issue("exports no `policy` (or `policies` list)");
      continue;
    }

    for (const p of found) {
      const problems = policyProblems(p);
      if (problems.length > 0) {
        issue(`not a policy: ${problems.join("; ")}`);
        continue;
      }

      const policy = p as Policy;
      loaded.policies.push({
        ...policy,
        ...(entry.settings ? { settings: entry.settings } : {}),
      } satisfies ConfiguredPolicy);
    }
  }

  return loaded;
}
