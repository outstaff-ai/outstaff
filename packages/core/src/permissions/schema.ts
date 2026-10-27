import { z } from "zod";
import { CONFIG_CODES } from "#/config/codes.js";
import { customIssue } from "#/config/issues.js";
import { PROFILES } from "./constants.js";
import { checkEntries } from "./tool-entries.js";
import { checkOptions } from "./tool-options.js";

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

const TOOL_NAME = /^[a-z0-9][a-z0-9._-]*$/;

/** Dotted numbers with an optional suffix; ranges, prefixes and aliases such as "latest" do not match. */
const EXACT_VERSION = /^v?\d+(\.\d+)+([-+.][0-9A-Za-z.+-]+)?$/;

const OPTION_KEY = /^[A-Za-z0-9_-]+$/;
const optionKey = z.string().regex(OPTION_KEY, "Use letters, digits, dashes and underscores.");

/** A string, or a map for platform-keyed options such as platforms.linux-x64.url. */
export const optionValueSchema = z.union([
  z.string(),
  z.record(optionKey, z.union([z.string(), z.record(optionKey, z.string())])),
]);

export const toolRuleSchema = z
  .strictObject({
    program: programName("Optional; when given it must be the tool's own name.").optional(),
    ...commandMatchFields,
  })
  .meta(d("A command rule for the tool."));

/** A list of first subcommands, or structured rules: the shapes `allow` and `deny` of a tool take. */
const commandList = (verbs: string) =>
  z.union([
    z.array(z.string().min(1)).min(1).meta(d(verbs)),
    z.array(toolRuleSchema).min(1).meta(d("Structured command rules.")),
  ]);

export const toolDeclarationSchema = z
  .strictObject({
    version: z
      .string()
      .refine((v) => EXACT_VERSION.test(v), {
        message: 'Must be an exact version such as "1.23.4", not a range, prefix or alias.',
        params: { code: CONFIG_CODES.toolsInvalidVersion },
      })
      .meta(d('Exact version to install, for example "1.23.4".')),
    source: z
      .string()
      .regex(/^[a-z0-9_-]+:\S+$/, 'Use "<backend>:<name>", for example "ubi:vendor/their-cli".')
      .optional()
      .meta(
        d(
          "Where mise gets the tool, as a mise backend and name such as ubi:vendor/their-cli or npm:their-cli. Defaults to the tool name, which mise looks up in its registry.",
        ),
      ),
    options: z
      .record(optionKey, optionValueSchema)
      .optional()
      .meta(
        d(
          'Options mise passes to the tool\'s backend, such as url, bin_path and checksum for an http: source. A value is a string, or a map for platform-keyed options: platforms: { linux-x64: { url: "..." } }. Needs source.',
        ),
      ),
    valued_options: z
      .array(z.string().regex(/^--?[^\s=-][^\s=]*$/, "Use the option as typed, for example -c."))
      .min(1)
      .optional()
      .meta(
        d(
          "Options of the tool that take their value as the next word, such as -c or --context. Their values are never taken for a subcommand, so a rule finds `delete` in `acmectl -c prod delete`. `--option=value` is one word and needs no entry.",
        ),
      ),
    allow: z
      .union([z.literal("all"), commandList("Subcommand verbs the agent may run.")])
      .optional()
      .meta(
        d(
          'Narrows what the agent may run of the tool: "all" (the default: any arguments), a list of first subcommands, or structured rules. With a list or rules, only the commands they match run. Deny rules and the built-in denies still win.',
        ),
      ),
    deny: commandList("Subcommand verbs the agent may never run.")
      .optional()
      .meta(
        d(
          'Commands of the tool the agent may never run: a list of first subcommands, or structured rules. Deny always wins over allow, including "all". A deny rule also looks past the value of a leading option that is not in valued_options, so `-x value delete` cannot hide a denied `delete`.',
        ),
      ),
  })
  .meta(
    d("A tool installed at agent start, and optionally a narrower set of commands it may run."),
  );

export const toolsSchema = z
  .record(
    z
      .string()
      .regex(TOOL_NAME, "Use the program name: lowercase letters, digits, dots and dashes."),
    toolDeclarationSchema,
  )
  .superRefine((tools, ctx) => {
    const sources = new Map<string, string>();
    for (const [name, t] of Object.entries(tools)) {
      if (t.source) {
        const other = sources.get(t.source);
        if (other) {
          ctx.addIssue(
            customIssue(
              CONFIG_CODES.toolsDuplicate,
              `Source "${t.source}" is already used by tool "${other}".`,
              [name, "source"],
            ),
          );
        } else {
          sources.set(t.source, name);
        }
      }

      checkOptions(name, t, ctx);
      checkEntries(name, "allow", t.allow, ctx);
      checkEntries(name, "deny", t.deny, ctx);
    }
  })
  .meta(
    d(
      "Tools to install at agent start, by program name. The declaration of a person replaces the team's, and the team's replaces a catalog toolset's.",
    ),
  );

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
    rules: z.array(toolsetRuleSchema).optional().meta(d("Command rules.")),
    tools: toolsSchema.optional(),
  })
  .refine((t) => (t.rules?.length ?? 0) > 0 || Object.keys(t.tools ?? {}).length > 0, {
    message: "Give at least one rule or tool.",
  })
  .meta(d("A toolset: command rules for a family of tools, shipped as catalog data."));

export const teamCommandSchema = z
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
    allow: z
      .array(teamCommandSchema)
      .optional()
      .meta(
        d(
          "Commands agents may run of a program. Everything runs by default; once a rule here names a program, the program runs only what such rules allow, and built-in default denies for it (such as kubectl apply) are lifted.",
        ),
      ),
    deny: z
      .array(teamCommandSchema)
      .optional()
      .meta(d("Commands agents may never run. Deny always wins over allow.")),
  })
  .meta(d("Command rules for this team's own tools, on top of the built-in and toolset rules."));
