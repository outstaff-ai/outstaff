import { messageSchema } from "./schemas/message.js";
import type { DecodeResult, Message } from "./types.js";
import { MESSAGE_META } from "./meta.js";

const MAX_ID = 200;

/** Parses one frame. Never throws: bad input comes back as an error to send to the peer. */
export function decode(raw: string): DecodeResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, code: "malformed", message: "The message is not valid JSON." };
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, code: "malformed", message: "The message must be a JSON object." };
  }

  const rec = value as Record<string, unknown>;
  const id = typeof rec["id"] === "string" && rec["id"].length <= MAX_ID ? rec["id"] : undefined;
  const base = id === undefined ? {} : { id };
  if (typeof rec["type"] !== "string") {
    return { ok: false, code: "malformed", message: "The message has no type.", ...base };
  }

  if (!Object.hasOwn(MESSAGE_META, rec["type"])) {
    return {
      ok: false,
      code: "unknown_type",
      message: `Unknown message type "${rec["type"].slice(0, 50)}".`,
      ...base,
    };
  }

  const parsed = messageSchema.safeParse(value);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) =>
      i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message,
    );

    return { ok: false, code: "invalid_message", message: problems.join("; "), ...base };
  }

  return { ok: true, message: parsed.data };
}

export const encode = (message: Message): string => JSON.stringify(message);
