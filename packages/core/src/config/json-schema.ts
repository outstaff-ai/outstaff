import { z } from "zod";
import { teamConfigSchema } from "./schema.js";

/** JSON Schema of the file as users write it (defaults are optional keys). */
export function buildTeamJsonSchema(): Record<string, unknown> {
  return {
    ...z.toJSONSchema(teamConfigSchema, { io: "input", target: "draft-7" }),
    title: "Outstaff team.yaml",
  };
}
