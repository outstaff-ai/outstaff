import type { z } from "zod";
import { CONFIG_CODES } from "./codes.js";

export type ConfigIssue = {
  path: (string | number)[];
  code: string;
  message: string;
};

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

export function toConfigIssues(error: z.ZodError, prefix: (string | number)[] = []): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  for (const issue of error.issues) {
    const path = [...prefix, ...issue.path.map((p) => (typeof p === "symbol" ? String(p) : p))];
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        out.push({
          path: [...path, key],
          code: CONFIG_CODES.unknownKey,
          message: `Unknown key "${key}".`,
        });
      }

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
