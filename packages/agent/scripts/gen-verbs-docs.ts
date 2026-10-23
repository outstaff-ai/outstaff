import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { VERBS, renderVerbsReference } from "../src/verbs/index.js";

const target = fileURLToPath(
  new URL("../../../docs/src/content/docs/reference/agent-verbs.md", import.meta.url),
);

writeFileSync(target, renderVerbsReference(VERBS));
console.log(`Wrote ${target}`);
