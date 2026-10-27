import { z } from "zod";
import { CAPABILITIES } from "#/capabilities.js";

const d = (description: string) => ({ description });
const SLUG = /^[a-z][a-z0-9-]*$/;
const slug = z
  .string()
  .regex(SLUG, "Use lowercase letters, digits and dashes, starting with a letter.");

const markdownFile = z
  .string()
  .regex(/^[\w.-]+\.md$/, "Use a plain .md file name inside the role directory.")
  .refine((v) => !v.startsWith(".."), "Use a plain .md file name inside the role directory.");

/** `roles/<role>/role.yaml`. */
export const roleSchema = z
  .strictObject({
    name: slug.meta(d("Role id; must equal the directory name.")),
    title: z.string().min(1).meta(d('Display title, for example "Developer".')),
    summary: z.string().min(1).meta(d("One line on what the role does.")),
    toolset: z.enum(["base", "code", "infra"]).meta(d("Which tool bundle the agent gets.")),
    permissions: z.enum(["readonly", "docs", "code", "infra"]).meta(d("Permission profile.")),
    needs: z
      .array(z.enum(CAPABILITIES))
      .default([])
      .meta(d("Capabilities the role cannot work without.")),
    optional_needs: z
      .array(z.enum(CAPABILITIES))
      .default([])
      .meta(d("Capabilities the role uses when available.")),
    default_model: z.string().min(1).optional().meta(d("Model used when the person has none.")),
    modes: z
      .array(z.strictObject({ name: slug, when: z.string().min(1) }))
      .default([])
      .meta(d("Named ways of working and when each applies.")),
    extends: z.array(slug).optional().meta(d("Roles whose skills are included in this one.")),
    files: z
      .strictObject({
        skill: markdownFile.default("SKILL.md"),
      })
      .default({ skill: "SKILL.md" })
      .meta(d("File names inside the role directory.")),
  })
  .meta(d("A catalog role (roles/<role>/role.yaml)."));
