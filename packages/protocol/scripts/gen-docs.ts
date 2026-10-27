import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderLinkReference } from "../src/link/docs.js";
import { renderProtocolReference } from "../src/docs.js";

const page = (name: string) =>
  fileURLToPath(new URL(`../../../docs/src/content/docs/reference/${name}`, import.meta.url));

for (const [name, text] of [
  ["agent-protocol.md", renderProtocolReference()],
  ["office-link.md", renderLinkReference()],
] as const) {
  writeFileSync(page(name), text);
  console.log(`Wrote ${page(name)}`);
}
