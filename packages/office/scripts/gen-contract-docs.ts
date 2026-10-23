import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { agentRegistry } from "@outstaff/agent";
import { applySecretsBlock, renderSecretsBlock } from "../src/contract.js";
import { officeRegistry } from "../src/main.js";

const target = fileURLToPath(
  new URL("../../../docs/src/content/docs/reference/container-contract.md", import.meta.url),
);

writeFileSync(
  target,
  applySecretsBlock(
    readFileSync(target, "utf8"),
    renderSecretsBlock(officeRegistry(), agentRegistry()),
  ),
);

console.log(`Wrote ${target}`);
