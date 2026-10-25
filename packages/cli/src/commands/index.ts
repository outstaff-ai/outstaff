import type { CommandDef } from "../define.js";
import { build } from "./build.js";
import { diff } from "./diff.js";
import { doctor } from "./doctor.js";
import { eject } from "./eject.js";
import { gitCredential } from "./git-credential.js";
import { fire } from "./fire.js";
import { hire } from "./hire.js";
import { init } from "./init.js";
import { policies } from "./policies.js";
import { render } from "./render.js";
import { roleNew } from "./role.js";
import { setup } from "./setup.js";
import { team } from "./team.js";
import { upgrade } from "./upgrade.js";
import { validate } from "./validate.js";
import { verbCommands } from "./verbs.js";
import { explain } from "./workflow.js";

export { groupSummaries } from "./verbs.js";

export const commands: CommandDef[] = [
  validate,
  team,
  render,
  eject,
  roleNew,
  diff,
  upgrade,
  build,
  init,
  setup,
  hire,
  fire,
  doctor,
  policies,
  explain,
  gitCredential,
  ...verbCommands,
];
