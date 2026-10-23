import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderCliReference } from "../src/reference.js";

const target = fileURLToPath(new URL("../cli-reference.md", import.meta.url));
writeFileSync(target, renderCliReference());
console.log(`Wrote ${target}`);
