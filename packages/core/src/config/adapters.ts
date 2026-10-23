import type { z } from "zod";
import { CONFIG_CODES } from "./codes.js";
import { toConfigIssues, type ConfigIssue } from "./issues.js";
import type { TeamConfig } from "./schema.js";

export const ADAPTER_PORTS = ["chat", "vcs", "runtime", "tracker", "knowledge", "avatars", "mail"] as const;
export type AdapterPort = (typeof ADAPTER_PORTS)[number];

const registry = new Map<string, z.ZodType>();
const key = (port: AdapterPort, adapter: string) => `${port}:${adapter}`;

/** Adapters register the schema of their own options (everything except `adapter`). */
export function registerAdapterOptions(port: AdapterPort, adapterName: string, schema: z.ZodType): void {
  registry.set(key(port, adapterName), schema);
}

export function clearAdapterOptions(): void {
  registry.clear();
}

/** Validate each integration's extra keys against its registered schema. Unknown adapters pass. */
export function validateAdapterOptions(config: TeamConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  for (const port of ADAPTER_PORTS) {
    const ref = config.integrations[port];
    if (!ref) continue;
    const schema = registry.get(key(port, ref.adapter));
    if (!schema) continue;
    const { adapter: _adapter, ...options } = ref;
    const result = schema.safeParse(options);
    if (!result.success) {
      for (const issue of toConfigIssues(result.error, ["integrations", port])) {
        issues.push(issue.code.startsWith("schema.") || issue.code === CONFIG_CODES.invalid ? { ...issue, code: CONFIG_CODES.adapterInvalidOptions } : issue);
      }
    }
  }
  return issues;
}
