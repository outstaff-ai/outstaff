import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BUILT_IN_POLICIES, POLICY_SWITCH_OF } from "../src/pipeline/policies/index.js";
import { renderPolicyReference } from "../src/pipeline/reference.js";

const target = fileURLToPath(
  new URL("../../../docs/src/content/docs/reference/pipeline-policies.md", import.meta.url),
);

writeFileSync(target, renderPolicyReference(BUILT_IN_POLICIES, POLICY_SWITCH_OF));
console.log(`Wrote ${target}`);
