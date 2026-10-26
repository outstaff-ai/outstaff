import { linkMessageSchema } from "./schemas.js";
import type { LinkMessage } from "./types.js";

/** Parses one frame of the office link. Never throws: the error says what is wrong. */
export function decodeLinkMessage(
  raw: string,
):
  | { ok: true; message: LinkMessage }
  | { ok: false; problem: string; id?: string; method?: string } {
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
  const payload = (value as { payload?: { id?: unknown; method?: unknown } } | null)?.payload;
  const id = typeof payload?.id === "string" ? payload.id : undefined;
  const method = typeof payload?.method === "string" ? payload.method : undefined;
  return {
    ok: false,
    problem: parsed.error.issues
      .map((i) => `${i.path.join(".") || "message"}: ${i.message}`)
      .join("; "),
    ...(id ? { id } : {}),
    ...(method ? { method } : {}),
  };
}

export const encodeLinkMessage = (message: LinkMessage): string => JSON.stringify(message);
