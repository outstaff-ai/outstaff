import { messageSchema } from "./schemas/message.js";
import type { DecodeResult, Message } from "./types.js";
import { MESSAGE_META } from "./meta.js";

const MAX_ID = 200;

type Failure = Extract<DecodeResult, { ok: false }>;

const malformed = (message: string): Failure => ({ ok: false, code: "malformed", message });

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The frame as a JSON object, or the error explaining why it is not one. */
function parseObject(raw: string): { ok: true; rec: Record<string, unknown> } | Failure {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return malformed("The message is not valid JSON.");
  }

  return isPlainObject(value)
    ? { ok: true, rec: value }
    : malformed("The message must be a JSON object.");
}

/** The id to echo back in an error, when the frame carries a usable one. */
function echoId(rec: Record<string, unknown>): { id?: string } {
  const id = rec["id"];
  return typeof id === "string" && id.length <= MAX_ID ? { id } : {};
}

const describeIssues = (issues: readonly { path: readonly PropertyKey[]; message: string }[]) =>
  issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");

/** Parses one frame. Never throws: bad input comes back as an error to send to the peer. */
export function decode(raw: string): DecodeResult {
  const object = parseObject(raw);
  if (!object.ok) {
    return object;
  }

  const { rec } = object;
  const base = echoId(rec);
  const type = rec["type"];
  if (typeof type !== "string") {
    return { ...malformed("The message has no type."), ...base };
  }

  if (!Object.hasOwn(MESSAGE_META, type)) {
    const message = `Unknown message type "${type.slice(0, 50)}".`;
    return { ok: false, code: "unknown_type", message, ...base };
  }

  const parsed = messageSchema.safeParse(rec);
  if (!parsed.success) {
    return {
      ok: false,
      code: "invalid_message",
      message: describeIssues(parsed.error.issues),
      ...base,
    };
  }

  return { ok: true, message: parsed.data };
}

export const encode = (message: Message): string => JSON.stringify(message);
