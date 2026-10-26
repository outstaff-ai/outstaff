import type { Message, MessageType, PayloadOf } from "@outstaff/protocol";
import { ProtocolError } from "./errors.js";
import type { ChatDesk } from "./source.types.js";
import type { Connection, ProtocolServerOptions, RequestContext } from "./types.js";

function desk(opts: ProtocolServerOptions): ChatDesk {
  if (!opts.chat) {
    throw new ProtocolError("unsupported", "This office does not take chat requests.");
  }

  return opts.chat;
}

/** Answers one request of an authenticated agent; a `ProtocolError` it throws is sent back as is. */
export async function handleRequest(
  ctx: RequestContext,
  c: Connection,
  person: string,
  m: Message,
): Promise<void> {
  const { opts, send, deliver } = ctx;
  const { source } = opts;
  const reply = <T extends MessageType>(type: T, payload: PayloadOf<T>) =>
    send(c, type, payload, m.id);

  switch (m.type) {
    case "ping":
      return reply("pong", {});
    case "pong":
      return;
    case "heartbeat":
      await source.heartbeat(person, m.payload.workItemId);
      return reply("ack", {});
    case "accept":
      await source.accept(person, m.payload.workItemId);
      return reply("ack", {});
    case "decline":
      await source.decline(person, m.payload.workItemId, m.payload.reason);
      c.offered.delete(m.payload.workItemId);
      return reply("ack", {});
    case "progress":
      await source.progress(person, m.payload.workItemId, m.payload.text);
      return reply("ack", {});
    case "usage":
      if (!opts.usage) {
        throw new ProtocolError("unsupported", "This office does not take usage reports.");
      }

      await opts.usage.report(person, m.payload.windows);
      return reply("ack", {});
    case "session":
      await source.setSession(person, m.payload.workItemId, m.payload.sessionId);
      return reply("ack", {});
    case "journal":
      await source.journal(person, m.payload.workItemId, m.payload.text);
      return reply("ack", {});
    case "handback": {
      const { workItemId, ...result } = m.payload;
      await source.handBack(person, workItemId, result);
      await opts.messaging?.onHandBack?.(workItemId, result.status);
      reply("ack", {});
      return deliver(person);
    }

    case "fail":
      await source.fail(person, m.payload.workItemId, m.payload.reason);
      reply("ack", {});
      return deliver(person);
    case "ask": {
      if (!opts.messaging) {
        throw new ProtocolError("unsupported", "This office does not route questions.");
      }

      return reply("ask_result", await opts.messaging.ask(person, m.payload));
    }

    case "answer": {
      if (!opts.messaging) {
        throw new ProtocolError("unsupported", "This office does not route questions.");
      }

      await opts.messaging.answer(person, m.payload.questionId, m.payload.answer);
      return reply("ack", {});
    }

    case "roster":
      return reply(
        "roster_result",
        opts.messaging?.roster ? await opts.messaging.roster() : { members: await source.roster() },
      );
    case "work_list":
      return reply("work_list_result", {
        items: await source.list(
          person,
          m.payload.workItemId === undefined ? {} : { workItemId: m.payload.workItemId },
        ),
      });
    case "work_move":
      return reply("work_move_result", {
        item: await source.move(person, m.payload.workItemId, m.payload.status),
      });
    case "work_place":
      return reply("work_move_result", {
        item: await source.place(
          person,
          m.payload.workItemId,
          m.payload.position,
          m.payload.relativeTo,
        ),
      });
    case "chat_message":
      return reply("chat_message_result", await desk(opts).message(person, m.payload));
    case "chat_report":
      return reply(
        "chat_report_result",
        await desk(opts).report(person, m.payload.workItemId, m.payload.kind),
      );
    case "work_link":
      return reply(
        "work_link_result",
        await desk(opts).linkTicket(
          person,
          m.payload.workItemId,
          m.payload.ticket,
          m.payload.request,
        ),
      );
    case "work_check":
      await desk(opts).checkFiling(person, m.payload.workItemId, m.payload.request);
      return reply("ack", {});
    case "work_queue":
      return reply(
        "work_queue_result",
        await desk(opts).queueWork(person, m.payload.workItemId, {
          title: m.payload.title,
          body: m.payload.body,
        }),
      );
    case "work_attach":
      return reply(
        "work_attach_result",
        await desk(opts).attachWork(person, m.payload.workItemId, {
          target: m.payload.target,
          confirmed: m.payload.confirmed,
          ...(m.payload.request ? { request: m.payload.request } : {}),
        }),
      );
    case "report_posted":
      await desk(opts).posted(person, m.payload.workItemId, m.payload.id);
      return reply("ack", {});
    case "doc_link": {
      if (!opts.docs) {
        throw new ProtocolError("unsupported", "This office does not track documents.");
      }

      await opts.docs.link(person, m.payload.workItemId, m.payload.doc);
      return reply("ack", {});
    }

    case "current_work":
      return reply("current_work_result", { text: await desk(opts).currentWork(person) });
    case "ticket_prs": {
      if (!opts.tickets) {
        throw new ProtocolError(
          "unsupported",
          "This office does not track tickets and pull requests.",
        );
      }

      return reply("ticket_prs_result", await opts.tickets.forDraft(m.payload));
    }

    default:
      throw new ProtocolError("invalid", `Agents do not send "${m.type}".`);
  }
}
