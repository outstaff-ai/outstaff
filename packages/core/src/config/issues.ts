import type { z } from "zod";
import { CONFIG_CODES } from "./codes.js";
import { removedKey, REMOVED_TEAM_KEYS } from "./removed-keys.js";
import type { ConfigIssue, RemovedKeys } from "./types.js";

const BY_ZOD_CODE: Record<string, string> = {
  invalid_type: CONFIG_CODES.invalidType,
  invalid_value: CONFIG_CODES.invalidValue,
  invalid_format: CONFIG_CODES.invalidFormat,
  too_small: CONFIG_CODES.tooSmall,
  too_big: CONFIG_CODES.tooBig,
};

/** Custom rules attach their stable code via `params.code`. */
export function customIssue(code: string, message: string, path: (string | number)[]) {
  return { code: "custom" as const, message, path, params: { code } };
}

function unknownKey(path: (string | number)[], keys: RemovedKeys): ConfigIssue {
  const removed = removedKey(path, keys);

  return removed === undefined
    ? { path, code: CONFIG_CODES.unknownKey, message: `Unknown key "${String(path.at(-1))}".` }
    : { path, code: CONFIG_CODES.removedKey, message: removed };
}

/** `removed` names the keys of this schema that are gone, with what to do instead. */
export function toConfigIssues(
  error: z.ZodError,
  prefix: (string | number)[] = [],
  removed: RemovedKeys = REMOVED_TEAM_KEYS,
): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  for (const issue of error.issues) {
    const path = [...prefix, ...issue.path.map((p) => (typeof p === "symbol" ? String(p) : p))];
    if (issue.code === "unrecognized_keys") {
      out.push(...issue.keys.map((key) => unknownKey([...path, key], removed)));

      continue;
    }

    const custom = (issue as { params?: { code?: string } }).params?.code;
    out.push({
      path,
      code: custom ?? BY_ZOD_CODE[issue.code] ?? CONFIG_CODES.invalid,
      message: issue.message,
    });
  }

  return out;
}
