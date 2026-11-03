import { CONFIG_CODES } from "./codes.js";
import type { ConfigIssue } from "./types.js";
import type { TeamCheck } from "./validate.types.js";

const PATH = ["memory", "store"];

/** `memory.store: knowledge` needs a knowledge integration that keeps notes; there is no fallback to the volume. */
export function memoryStoreErrors({ config, provided, adaptersKnown }: TeamCheck): ConfigIssue[] {
  if (config.memory?.store !== "knowledge") {
    return [];
  }

  const knowledge = config.integrations.knowledge;
  if (!knowledge) {
    return [
      {
        path: PATH,
        code: CONFIG_CODES.memoryStoreUnsupported,
        message:
          "memory.store is knowledge, but no knowledge integration is configured. Configure integrations.knowledge or use store: volume.",
      },
    ];
  }

  if (adaptersKnown && !provided.has("knowledge.notes")) {
    return [
      {
        path: PATH,
        code: CONFIG_CODES.memoryStoreUnsupported,
        message: `memory.store is knowledge, but the knowledge adapter "${knowledge.adapter}" does not provide knowledge.notes. Use store: volume.`,
      },
    ];
  }

  return [];
}
