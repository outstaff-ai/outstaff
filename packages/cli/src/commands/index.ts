import type { CommandDef } from "../define.js";
import { init } from "./init.js";
import { render } from "./render.js";
import { team } from "./team.js";
import { validate } from "./validate.js";
import { verbCommands } from "./verbs.js";
import { explain } from "./workflow.js";

export { groupSummaries } from "./verbs.js";

export const commands: CommandDef[] = [validate, team, render, init, explain, ...verbCommands];
