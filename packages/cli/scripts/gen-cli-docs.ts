import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderCliReference } from "../src/reference.js";

const target = fileURLToPath(
  new URL("../../../docs/src/content/docs/reference/cli.md", import.meta.url),
);

writeFileSync(target, renderCliReference());
console.log(`Wrote ${target}`);
