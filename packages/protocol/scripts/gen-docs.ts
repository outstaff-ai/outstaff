import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderProtocolReference } from "../src/docs.js";

const target = fileURLToPath(
  new URL("../../../docs/src/content/docs/reference/agent-protocol.md", import.meta.url),
);

writeFileSync(target, renderProtocolReference());
console.log(`Wrote ${target}`);
