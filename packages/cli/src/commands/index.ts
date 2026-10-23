import type { CommandDef } from "../define.js";
import { init } from "./init.js";
import { render } from "./render.js";
import { team } from "./team.js";
import { validate } from "./validate.js";

export const commands: CommandDef[] = [validate, team, render, init];
