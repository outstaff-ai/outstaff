import type { Message } from "@outstaff/protocol";
import type { Connection, HelloContext } from "./types.js";

/**
 * Answers the messages that only say the agent is alive (`heartbeat`, `ping`, `pong`) as soon as they arrive, ahead of
 * the requests queued before them: a slow request must not make the agent think the office is gone. A heartbeat is
 * acked first and its item touched after; a failure to touch it is only logged, the stale sweep is the backstop.
 * False for any other message, or before the connection is authenticated.
 */
export function answerAtOnce(ctx: HelloContext, c: Connection, m: Message): boolean {
  const { person } = c;
  if (person === undefined) {
    return false;
  }

  switch (m.type) {
    case "heartbeat":
      ctx.armIdle(c, ctx.heartbeatMs * 3);
      ctx.send(c, "ack", {}, m.id);
      ctx.opts.source.heartbeat(person, m.payload.workItemId).catch((err: unknown) => {
        ctx.log.warn("could not record a heartbeat", {
          person,
          item: m.payload.workItemId,
          error: String(err),
        });
      });

      return true;
    case "ping":
      ctx.armIdle(c, ctx.heartbeatMs * 3);
      ctx.send(c, "pong", {}, m.id);
      return true;
    case "pong":
      ctx.armIdle(c, ctx.heartbeatMs * 3);
      return true;
    default:
      return false;
  }
}
