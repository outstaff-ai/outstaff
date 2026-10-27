import type { z } from "zod";
import { CONFIG_CODES } from "./codes.js";
import { toConfigIssues } from "./issues.js";
import type { AdapterPort, ConfigIssue, TeamConfig } from "./types.js";

export const ADAPTER_PORTS = ["chat", "vcs", "runtime", "tracker", "knowledge", "avatars"] as const;

const registry = new Map<string, z.ZodType>();
const key = (port: AdapterPort, adapter: string) => `${port}:${adapter}`;

/** Adapters register the schema of their own options (everything except `adapter`). */
export function registerAdapterOptions(
  port: AdapterPort,
  adapterName: string,
  schema: z.ZodType,
): void {
  registry.set(key(port, adapterName), schema);
}

export function clearAdapterOptions(): void {
  registry.clear();
}

type Ref = { adapter: string } & Record<string, unknown>;

/** One adapter choice's options checked against the schema its adapter registered; an unknown adapter passes. */
function optionIssues(port: AdapterPort, ref: Ref, base: (string | number)[]): ConfigIssue[] {
  const schema = registry.get(key(port, ref.adapter));
  if (!schema) {
    return [];
  }

  const { adapter: _adapter, ...options } = ref;
  const result = schema.safeParse(options);
  if (result.success) {
    return [];
  }

  return toConfigIssues(result.error, base).map((issue) =>
    issue.code.startsWith("schema.") || issue.code === CONFIG_CODES.invalid
      ? { ...issue, code: CONFIG_CODES.adapterInvalidOptions }
      : issue,
  );
}

/** Validate each integration's extra keys, and each person's own runtime, against the registered schemas. */
export function validateAdapterOptions(config: TeamConfig): ConfigIssue[] {
  const team = ADAPTER_PORTS.flatMap((port) => {
    const ref = config.integrations[port];
    return ref ? optionIssues(port, ref, ["integrations", port]) : [];
  });

  const people = config.people.flatMap((p, i) =>
    p.runtime ? optionIssues("runtime", p.runtime, ["people", i, "runtime"]) : [],
  );

  return [...team, ...people];
}
