import { writeFileSync } from "node:fs";
import { buildTeamJsonSchema } from "../src/config/json-schema.js";

const out = new URL("../schema/team.schema.json", import.meta.url);
writeFileSync(out, `${JSON.stringify(buildTeamJsonSchema(), null, 2)}\n`);
