import { cpSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the synthetic acme team file shipped in the repository. */
export const ACME_TEAM_FILE = fileURLToPath(
  new URL("../../../examples/acme/.outstaff/team.yaml", import.meta.url),
);

/** The real stock catalog (packages/catalog). */
export const STOCK_CATALOG_DIR = fileURLToPath(
  new URL("../../../packages/catalog", import.meta.url),
);

/** A tiny catalog with one `example` role, for tests of the loader and renderer. */
export const EXAMPLE_CATALOG_DIR = fileURLToPath(new URL("./example-catalog", import.meta.url));

export const readAcmeTeam = (): string => readFileSync(ACME_TEAM_FILE, "utf8");

/** The acme team's custom policies, which its team file loads from `./policies`. */
export const ACME_POLICIES_DIR = join(ACME_TEAM_FILE, "..", "policies");

/** Copies the acme team's custom policies next to a copy of its team file, so `ost validate` can load them. */
export const copyAcmePolicies = (outstaffDir: string): void =>
  cpSync(ACME_POLICIES_DIR, join(outstaffDir, "policies"), { recursive: true });

const acme = readAcmeTeam();

const replaceOnce = (text: string, from: string, to: string): string => {
  if (!text.includes(from)) {
    throw new Error(`fixture anchor not found: ${from}`);
  }

  return text.replace(from, to);
};

/** Two agents share the handle "sam". */
export const DUPLICATE_HANDLE_TEAM = replaceOnce(acme, "handle: noor", "handle: sam");

/** Agent at people[4] ("sam") is granted a repo that is not declared. */
export const UNKNOWN_REPO_GRANT_TEAM = replaceOnce(
  acme,
  '      shop: write\n      "kind:baseline": read\n  - handle: noor',
  "      shop: write\n      billing: read\n  - handle: noor",
);

/** An unclosed flow sequence. */
export const YAML_SYNTAX_ERROR_TEAM = replaceOnce(
  acme,
  "extends: [developer]",
  "extends: [developer",
);

/** The required `repos` key is missing. */
export const MISSING_REPOS_TEAM = acme.replace(/\nrepos:[\s\S]*?\npeople:/, "\npeople:");

/** Agent at people[4] ("sam") has no model. */
export const MISSING_MODEL_TEAM = replaceOnce(
  acme,
  "    role: developer\n    model: sonnet\n",
  "    role: developer\n",
);
