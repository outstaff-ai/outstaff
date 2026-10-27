import type { z } from "zod";
import type { AgentEnv, Verb, VerbContext, VerbResult } from "./types.js";

export function defineVerb<S extends z.ZodObject>(
  verb: Omit<Verb, "input" | "run" | "cli"> & {
    cli?: string[];
    input: S;
    run(env: AgentEnv, input: z.output<S>, ctx: VerbContext): Promise<VerbResult>;
  },
): Verb {
  return verb as unknown as Verb;
}

/** Text from lines and the links they must contain. */
export function result(lines: string[], data: unknown, links: string[]): VerbResult {
  const unique = [...new Set(links)];
  const text = lines.join("\n");
  const missing = unique.filter((l) => !text.includes(l));
  return {
    text: missing.length ? `${text}\n${missing.join("\n")}` : text,
    data,
    links: unique,
  };
}
