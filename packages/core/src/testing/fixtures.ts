import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Absolute path of the synthetic acme team file shipped in the repository. */
export const ACME_TEAM_FILE = fileURLToPath(
  new URL("../../../../examples/acme/.outstaff/team.yaml", import.meta.url),
);

export const readAcmeTeam = (): string => readFileSync(ACME_TEAM_FILE, "utf8");

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
