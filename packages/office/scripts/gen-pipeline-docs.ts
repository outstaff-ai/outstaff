import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_POLICIES, POLICY_SWITCH_OF } from "../src/pipeline/defaults.js";
import { renderPolicyReference } from "../src/pipeline/reference.js";

const target = fileURLToPath(
  new URL("../../../docs/src/content/docs/reference/pipeline-policies.md", import.meta.url),
);

writeFileSync(target, renderPolicyReference(DEFAULT_POLICIES, POLICY_SWITCH_OF));
console.log(`Wrote ${target}`);
