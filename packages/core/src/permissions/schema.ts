import { z } from "zod";
import { CONFIG_CODES } from "../config/codes.js";
import { customIssue } from "../config/issues.js";
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

const TOOL_NAME = /^[a-z0-9][a-z0-9._-]*$/;

/** Dotted numbers with an optional suffix; ranges, prefixes and aliases such as "latest" do not match. */
const EXACT_VERSION = /^v?\d+(\.\d+)+([-+.][0-9A-Za-z.+-]+)?$/;

const OPTION_KEY = /^[A-Za-z0-9_-]+$/;
const optionKey = z.string().regex(OPTION_KEY, "Use letters, digits, dashes and underscores.");

/** A string, or a map for platform-keyed options such as platforms.linux-x64.url. */
const optionValueSchema = z.union([
  z.string(),
  z.record(optionKey, z.union([z.string(), z.record(optionKey, z.string())])),
]);

export type ToolOptionValue = z.output<typeof optionValueSchema>;

const toolRuleSchema = z
  .strictObject({
    program: programName("Optional; when given it must be the tool's own name.").optional(),
    ...commandMatchFields,
  })
  .meta(d("A command rule for the tool."));

export type ToolRuleInput = z.input<typeof toolRuleSchema>;

const toolDeclarationSchema = z
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
    allow: z
      .union([
        z.literal("all"),
        z.array(z.string().min(1)).meta(d("Subcommand verbs the agent may run.")),
        z.array(toolRuleSchema).min(1).meta(d("Structured command rules.")),
      ])
      .meta(
        d(
          'What the agent may run: "all" (any arguments), a list of first subcommands, or structured rules. Installing a tool allows nothing by itself. The built-in denies still win.',
        ),
      ),
  })
  .meta(d("A tool installed at agent start, with the commands it may run."));

export type ToolDeclaration = z.output<typeof toolDeclarationSchema>;

const isMap = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const hasChecksum = (v: unknown) => typeof v === "string" && v.trim() !== "";

function checkOptions(name: string, t: ToolDeclaration, ctx: z.RefinementCtx) {
  const { options, source } = t;
  if (options === undefined) {
    if (source?.startsWith("http:")) {
      ctx.addIssue(
        customIssue(
          CONFIG_CODES.toolsHttpChecksum,
          `Tool "${name}" has an http: source and needs options.checksum, or one per platform.`,
          [name, "options"],
        ),
      );
    }

    return;
  }

  if (source === undefined) {
    ctx.addIssue(
      customIssue(
        CONFIG_CODES.toolsOptionsWithoutSource,
        `Tool "${name}" sets options but no source; options go to the backend the source names.`,
        [name, "options"],
      ),
    );
  }

  if ("version" in options) {
    ctx.addIssue(
      customIssue(
        CONFIG_CODES.toolsReservedOption,
        `Tool "${name}" sets options.version; use the version field.`,
        [name, "options", "version"],
      ),
    );
  }

  if (!source?.startsWith("http:") || hasChecksum(options["checksum"])) {
    return;
  }

  const platforms = isMap(options["platforms"]) ? Object.entries(options["platforms"]) : [];
  const missing = platforms.filter(([, p]) => !isMap(p) || !hasChecksum(p["checksum"]));
  if (platforms.length === 0) {
    ctx.addIssue(
      customIssue(
        CONFIG_CODES.toolsHttpChecksum,
        `Tool "${name}" has an http: source and needs options.checksum, or one per platform.`,
        [name, "options", "checksum"],
      ),
    );
  }

  for (const [platform] of missing) {
    ctx.addIssue(
      customIssue(
        CONFIG_CODES.toolsHttpChecksum,
        `Platform "${platform}" of tool "${name}" has no checksum.`,
        [name, "options", "platforms", platform, "checksum"],
      ),
    );
  }
}

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

      if (!Array.isArray(t.allow)) {
        continue;
      }

      const seen = new Set<string>();
      t.allow.forEach((entry, i) => {
        if (typeof entry === "string") {
          if (seen.has(entry)) {
            ctx.addIssue(
              customIssue(CONFIG_CODES.toolsDuplicate, `Verb "${entry}" is listed twice.`, [
                name,
                "allow",
                i,
              ]),
            );
          }

          seen.add(entry);
        } else if (entry.program !== undefined && entry.program !== name) {
          ctx.addIssue(
            customIssue(
              CONFIG_CODES.toolsRuleProgram,
              `A rule of tool "${name}" names program "${entry.program}"; omit program or use "${name}".`,
              [name, "allow", i, "program"],
            ),
          );
        }
      });
    }
  })
  .meta(
    d(
      "Tools to install at agent start, by program name. The declaration of a person replaces the team's, and the team's replaces a catalog toolset's.",
    ),
  );

export type Tools = z.output<typeof toolsSchema>;

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
