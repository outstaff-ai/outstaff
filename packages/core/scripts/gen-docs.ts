import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderTeamYamlReference, renderValidationCodes } from "../src/docs/team-reference.js";

const example = readFileSync(
  new URL("../../../examples/acme/.outstaff/team.yaml", import.meta.url),
  "utf8",
);

const reference = new URL("../../../docs/src/content/docs/reference/", import.meta.url);

for (const [file, text] of [
  ["team-yaml.md", renderTeamYamlReference(example)],
  ["validation-codes.md", renderValidationCodes()],
] as const) {
  const target = fileURLToPath(new URL(file, reference));
  writeFileSync(target, text);
  console.log(`Wrote ${target}`);
}
