import { linkMessageSchema } from "./schemas.js";
import type { LinkMessage } from "./types.js";

type Failure = { ok: false; problem: string; id?: string; method?: string };

const text = (v: unknown) => (typeof v === "string" ? v : undefined);

/** What is wrong with a frame that parsed as JSON, and the request's id and method, when they can be read. */
function failure(value: unknown, problem: string): Failure {
  const payload = (value as { payload?: { id?: unknown; method?: unknown } } | null)?.payload;
  const id = text(payload?.id);
  const method = text(payload?.method);
  return { ok: false, problem, ...(id ? { id } : {}), ...(method ? { method } : {}) };
}

/** Parses one frame of the office link. Never throws: the error says what is wrong. */
export function decodeLinkMessage(raw: string): { ok: true; message: LinkMessage } | Failure {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, problem: "The frame is not valid JSON." };
  }

  const parsed = linkMessageSchema.safeParse(value);
  if (parsed.success) {
    return { ok: true, message: parsed.data };
  }

  // A request the office cannot read is still answered, when its id can be found.
  const problem = parsed.error.issues
    .map((i) => `${i.path.join(".") || "message"}: ${i.message}`)
    .join("; ");

  return failure(value, problem);
}

export const encodeLinkMessage = (message: LinkMessage): string => JSON.stringify(message);
