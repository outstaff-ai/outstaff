import type { Message, MessageType } from "@outstaff/protocol";
import { ProtocolError } from "./errors.js";
import { chatHandlers } from "./handlers/chat.js";
import { serviceHandlers } from "./handlers/services.js";
import { workHandlers } from "./handlers/work.js";
import type { Connection, RequestContext, RequestHandler, RequestHandlers } from "./types.js";

const handlers: RequestHandlers = { ...workHandlers, ...serviceHandlers, ...chatHandlers };

/** Answers one request of an authenticated agent; a `ProtocolError` it throws is sent back as is. */
export async function handleRequest(
  ctx: RequestContext,
  c: Connection,
  person: string,
  m: Message,
): Promise<void> {
  // A message type is matched to its own payload by the table, which the compiler cannot follow through the lookup.
  const handler = handlers[m.type] as RequestHandler<MessageType> | undefined;
  if (!handler) {
    throw new ProtocolError("invalid", `Agents do not send "${m.type}".`);
  }

  await handler({
    ctx,
    c,
    person,
    payload: m.payload,
    reply: (type, payload) => ctx.send(c, type, payload, m.id),
  });
}
