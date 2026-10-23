import { z } from "zod";
import { CONFIG_CODES } from "../config/codes.js";
import { PROFILES } from "./types.js";

const d = (description: string) => ({ description });

const WORD = /^[^\s/]+$/;

const argPredicateSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("flag"),
      names: z
        .array(z.string().min(1))
        .min(1)
        .meta(d("Flag spellings, for example [-X, --method].")),
      present: z
        .boolean()
        .meta(d("Whether one of the flags must (true) or must not (false) be present.")),
    }),
    z.strictObject({
      kind: z.literal("flag-value"),
      names: z.array(z.string().min(1)).min(1).meta(d("Flag spellings whose value is checked.")),
      values: z.array(z.string()).meta(d("Values compared case-insensitively.")),
      match: z.enum(["in", "not-in"]).meta(d("Whether the flag value is in or not in `values`.")),
    }),
    z.strictObject({
      kind: z.literal("positional"),
      index: z.int().min(0).meta(d("Position after the subcommand words, from 0.")),
      pattern: z
        .string()
        .min(1)
        .meta(d("Case-insensitive regular expression the argument matches.")),
    }),
  ])
  .meta(d("A condition on the command arguments."));

/** The fields that say which command a rule is about. Shared by toolsets and team.yaml. */
export const commandMatchFields = {
  subcommand: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .meta(d('Leading positional words, for example ["pr", "view"].')),
  args: z
    .array(argPredicateSchema)
    .min(1)
    .optional()
    .meta(d("Every condition must hold for the rule to apply.")),
  reason: z.string().min(1).meta(d("Why the rule exists; shown when it decides a call.")),
  requires_repo: z
    .enum(["read", "write"])
    .optional()
    .meta(d("The working repository must have at least this grant.")),
};

const programName = (description: string) =>
  z
    .string()
    .min(1)
    .regex(WORD, "Use the program name only, without spaces or a path.")
    .meta(d(description));

const toolsetRuleSchema = z
  .strictObject({
    program: z
      .union([programName("Program name."), z.array(programName("Program name.")).min(1)])
      .meta(d("Program name, or several programs sharing the rule.")),
    ...commandMatchFields,
    verbs: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .meta(
        d("Shorthand: one rule per verb, each a one-word subcommand. Exclusive with subcommand."),
      ),
    effect: z
      .enum(["allow", "deny"])
      .default("allow")
      .meta(d("Whether the rule allows or denies.")),
    path_args: z
      .enum(["read", "write"])
      .optional()
      .meta(d("Positional arguments are paths that must pass the read or write path rules.")),
  })
  .refine((r) => !(r.verbs && r.subcommand), {
    message: "Use either verbs or subcommand, not both.",
  })
  .meta(d("A command rule."));

export const toolsetSchema = z
  .strictObject({
    name: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/, "Use lowercase letters, digits and dashes.")
      .meta(d("Toolset name, matching the image variant.")),
    description: z.string().optional().meta(d("What the toolset covers.")),
    profiles: z
      .array(z.enum(PROFILES))
      .min(1)
      .optional()
      .meta(d("Profiles the rules apply to; all profiles when omitted.")),
    rules: z.array(toolsetRuleSchema).min(1).meta(d("Command rules.")),
  })
  .meta(d("A toolset: command rules for a family of tools, shipped as catalog data."));

export type Toolset = z.output<typeof toolsetSchema>;

const teamCommandSchema = z
  .strictObject({
    program: programName("Program name, for example make. Git is governed by repository grants."),
    ...commandMatchFields,
  })
  .refine((c) => c.program !== "git", {
    message: "Git is governed by repository grants; it cannot be listed here.",
    params: { code: CONFIG_CODES.policiesCommandProgram },
  })
  .meta(d("A command rule."));

export const teamCommandsSchema = z
  .strictObject({
    allow: z.array(teamCommandSchema).optional().meta(d("Commands agents may run.")),
    deny: z
      .array(teamCommandSchema)
      .optional()
      .meta(d("Commands agents may never run. Deny always wins over allow.")),
  })
  .meta(d("Extra commands for this team's own tools, on top of the built-in and toolset rules."));

export type TeamCommands = z.output<typeof teamCommandsSchema>;
export type CommandRuleInput = z.input<typeof teamCommandSchema>;
