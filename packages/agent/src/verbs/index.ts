import { PortError, type RuntimeTool } from "@outstaff/core";
import { adbVerbs } from "./adb.js";
import { docVerbs } from "./doc.js";
import { http } from "./http.js";
import { me } from "./me.js";
import { officeVerbs } from "./office-verbs.js";
import { prVerbs } from "./pr.js";
import { ticketVerbs } from "./ticket.js";
import type { AgentEnv, Verb, VerbContext, VerbResult } from "./types.js";

export { createAgentEnv } from "./env.js";
export type { CreateAgentEnvOptions } from "./types.js";
export { createFakeOffice } from "./office.js";
export type { FakeOffice } from "./office.types.js";
export type {
  ChatMessageRequest,
  ChatMessageResult,
  ChatReportKind,
  ChatReportResult,
  OfficeAnswer,
  OfficeClient,
  OfficeTeam,
  OfficeTeamMember,
  OfficeWorkItem,
  Placement,
} from "./office.types.js";

export { cliPath, describeVerb, kebab } from "./describe.js";
export type { VerbField } from "./types.js";
export { renderVerbsReference } from "./reference.js";
export type { AgentEnv, Verb, VerbContext, VerbResult } from "./types.js";

export const VERBS: readonly Verb[] = [
  ...ticketVerbs,
  ...docVerbs,
  ...prVerbs,
  me,
  ...officeVerbs,
  http,
  ...adbVerbs,
];

export const findVerb = (name: string): Verb | undefined => VERBS.find((v) => v.name === name);

/** Validates `raw` against the verb's schema and runs it. Throws `PortError` (`invalid` for bad input). */
export async function runVerb(
  verb: Verb,
  env: AgentEnv,
  raw: unknown,
  ctx: VerbContext = {},
): Promise<VerbResult> {
  const parsed = verb.input.safeParse(raw ?? {});
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) =>
      i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message,
    );

    throw new PortError("invalid", `${verb.name}: ${problems.join("; ")}`);
  }

  return verb.run(env, parsed.data as never, ctx);
}

export const toolName = (verb: Verb) => verb.name.replaceAll(".", "_");

/** The verbs as in-process tools for a runtime adapter. A failing verb rejects; the adapter reports it to the model. */
export function createRuntimeTools(
  env: AgentEnv,
  verbs: readonly Verb[] = VERBS,
  base: VerbContext = {},
): RuntimeTool[] {
  return verbs.map((verb) => ({
    name: toolName(verb),
    description: verb.description,
    input: verb.input,
    async handler(input, ctx) {
      return (await runVerb(verb, env, input, { ...base, ...ctx })).text;
    },
  }));
}
