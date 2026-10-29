import {
  VERBS,
  agentLayout,
  cliPath,
  createAgentEnv,
  describeVerb,
  kebab,
  runVerb,
  type AgentEnv,
  type Verb,
} from "@outstaff/agent";
import { homedir } from "node:os";
import {
  AdapterRegistry,
  PortError,
  buildPolicy,
  envSecretSource,
  formatIssue,
  type TeamConfig,
} from "@outstaff/core";
import { githubVcs } from "@outstaff/integration.vcs.github";
import { defineCommand } from "#/define.js";
import type { CommandDef, Context, GlobalOptions } from "#/types.js";
import { loadTeam } from "#/load.js";

export const groupSummaries: Record<string, string> = {
  ticket: "Read and update tickets in the team's tracker.",
  doc: "Read, write and discuss documents in the team's knowledge base.",
  pr: "Open, update, review and diff pull requests, and work their review threads.",
  role: "Add custom roles to the team's catalog.",
  workflow: "Inspect how the team workflow reacts to events.",
};

/** The adapters this build can create; teams using others get a clear message from the verbs that need them. */
export const defaultRegistry = () => new AdapterRegistry().register(githubVcs);

export class Failure extends Error {}

export async function buildEnv(ctx: Context, options: GlobalOptions): Promise<AgentEnv> {
  if (ctx.agentEnv) {
    return ctx.agentEnv();
  }

  const person = ctx.env["OUTSTAFF_PERSON"];
  if (!person) {
    throw new PortError("invalid", "Set OUTSTAFF_PERSON to the handle of the person you act as.");
  }

  const loaded = await loadTeam(ctx, options);
  if (!loaded.ok) {
    throw new Failure(loaded.issues.map(formatIssue).join("\n"));
  }

  const env = await createAgentEnv({
    team: loaded.config,
    person,
    registry: ctx.registry ?? defaultRegistry(),
    secrets: envSecretSource(ctx.env),
    ...(ctx.office ? { office: ctx.office } : {}),
  });

  applyReadPolicy(ctx, env, loaded.config, person);
  return env;
}

/** Gives the env the same read rules the agent's Read tool gets (the profile only changes what may be written). */
function applyReadPolicy(ctx: Context, env: AgentEnv, team: TeamConfig, person: string): void {
  const me = team.people.find((p) => p.handle === person);
  if (!me) {
    return;
  }

  const layout = agentLayout(
    ctx.env["HOME"] ?? homedir(),
    ctx.env["OUTSTAFF_SECRETS_DIR"] ?? "/run/secrets/outstaff",
  );

  env.layout = layout;
  env.policy = buildPolicy({ profile: "readonly", person: me, team, layout });
}

type VerbField = ReturnType<typeof describeVerb>[number];

/** The raw value of a field: its option, its positional argument, or the rest of the arguments for an array. */
function rawValue(f: VerbField, args: string[], options: Record<string, unknown>): unknown {
  if (f.arg === undefined) {
    return options[f.name];
  }

  if (f.type !== "array") {
    return args[f.arg];
  }

  // An array with nothing at its position is left out rather than given as [].
  return args.length > f.arg ? args.slice(f.arg) : undefined;
}

const isNumeric = (f: VerbField): boolean => f.type === "integer" || f.type === "number";

/** Positional arguments and options (commander's camelCase keys) -> the verb's input object. */
function toInput(verb: Verb, args: string[], options: Record<string, unknown>) {
  const input: Record<string, unknown> = {};
  for (const f of describeVerb(verb)) {
    const raw = rawValue(f, args, options);
    if (raw !== undefined) {
      input[f.name] = isNumeric(f) ? Number(raw) : raw;
    }
  }

  return input;
}

function command(verb: Verb): CommandDef {
  const path = cliPath(verb);
  const fields = describeVerb(verb);
  const positional = fields
    .filter((f) => f.arg !== undefined)
    .toSorted((a, b) => a.arg! - b.arg!)
    .map((f) => {
      const name = f.type === "array" ? `${f.name}...` : f.name;
      return f.required ? `<${name}>` : `[${name}]`;
    });

  return defineCommand({
    ...(path.length > 1 ? { group: path[0]! } : {}),
    name: path.at(-1)!,
    summary: verb.summary,
    description: verb.description,
    ...(positional.length ? { args: positional.join(" ") } : {}),
    options: fields
      .filter((f) => f.arg === undefined)
      .map((f) => ({
        flags: `--${kebab(f.name)}${f.type === "boolean" ? "" : ` <${f.name}${f.type === "array" ? "..." : ""}>`}`,
        description: f.description,
      })),
    examples: [...verb.examples, `${verb.examples[0]} --json`],
    exitCodes: [
      "0: the verb succeeded",
      "1: the input was invalid, the team or a port could not be reached, or the verb refused",
    ],
    async run(ctx, options, args) {
      const json = options.json === true;
      const fail = (code: string, message: string) => {
        if (json) {
          ctx.out(`${JSON.stringify({ error: { code, message } }, null, 2)}\n`);
        } else {
          ctx.err(`error    ${code}: ${message}\n`);
        }

        return 1;
      };

      try {
        const env = await buildEnv(ctx, options);
        const workItemId = ctx.env["OUTSTAFF_WORK_ITEM"];
        const result = await runVerb(
          verb,
          env,
          toInput(verb, args, options as Record<string, unknown>),
          { cwd: ctx.cwd, ...(workItemId ? { workItemId } : {}) },
        );

        ctx.out(json ? `${JSON.stringify(result, null, 2)}\n` : `${result.text}\n`);
        return 0;
      } catch (e) {
        if (e instanceof PortError) {
          return fail(e.code, e.message);
        }

        if (e instanceof Failure) {
          return fail("invalid", e.message);
        }

        throw e;
      }
    },
  });
}

export const verbCommands: CommandDef[] = VERBS.map(command);
