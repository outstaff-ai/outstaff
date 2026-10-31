import type { ChatDesk } from "#/protocol/source.types.js";
import { ProtocolError } from "#/protocol/errors.js";
import type { ProtocolServerOptions, RequestHandlers } from "#/protocol/types.js";

function desk(opts: ProtocolServerOptions): ChatDesk {
  if (!opts.chat) {
    throw new ProtocolError("unsupported", "This office does not take chat requests.");
  }

  return opts.chat;
}

/** Chat sessions: messages, reports, and filing a request as work. */
export const chatHandlers: RequestHandlers = {
  async chat_message({ ctx, person, payload, reply }) {
    reply("chat_message_result", await desk(ctx.opts).message(person, payload));
  },
  async chat_report({ ctx, person, payload, reply }) {
    const result = await desk(ctx.opts).report(person, payload.workItemId, payload.kind);
    reply("chat_report_result", result);
  },
  async work_link({ ctx, person, payload, reply }) {
    const { workItemId, ticket, request } = payload;
    reply("work_link_result", await desk(ctx.opts).linkTicket(person, workItemId, ticket, request));
  },
  async work_file_for({ ctx, person, payload, reply }) {
    const { workItemId, ...filing } = payload;
    await desk(ctx.opts).fileFor(person, workItemId, filing);
    reply("ack", {});
  },
  async work_check({ ctx, person, payload, reply }) {
    await desk(ctx.opts).checkFiling(person, payload.workItemId, payload.request);
    reply("ack", {});
  },
  async work_queue({ ctx, person, payload, reply }) {
    const { workItemId, title, body } = payload;
    reply("work_queue_result", await desk(ctx.opts).queueWork(person, workItemId, { title, body }));
  },
  async work_attach({ ctx, person, payload, reply }) {
    const { workItemId, target, confirmed, request } = payload;
    const result = await desk(ctx.opts).attachWork(person, workItemId, {
      target,
      confirmed,
      ...(request ? { request } : {}),
    });

    reply("work_attach_result", result);
  },
  async report_posted({ ctx, person, payload, reply }) {
    await desk(ctx.opts).posted(person, payload.workItemId, payload.id);
    reply("ack", {});
  },
  async current_work({ ctx, person, reply }) {
    reply("current_work_result", { text: await desk(ctx.opts).currentWork(person) });
  },
};
