import { defined } from "../../defined.js";
import type { RequestHandlers } from "../types.js";

/** The work loop: offers taken or declined, progress, and the result handed back. */
export const workHandlers: RequestHandlers = {
  ping: ({ reply }) => reply("pong", {}),
  pong: () => undefined,
  async heartbeat({ ctx, person, payload, reply }) {
    await ctx.opts.source.heartbeat(person, payload.workItemId);
    reply("ack", {});
  },
  async accept({ ctx, person, payload, reply }) {
    await ctx.opts.source.accept(person, payload.workItemId);
    reply("ack", {});
  },
  async decline({ ctx, c, person, payload, reply }) {
    await ctx.opts.source.decline(person, payload.workItemId, payload.reason);
    c.offered.delete(payload.workItemId);
    reply("ack", {});
  },
  async progress({ ctx, person, payload, reply }) {
    await ctx.opts.source.progress(person, payload.workItemId, payload.text);
    reply("ack", {});
  },
  async session({ ctx, person, payload, reply }) {
    await ctx.opts.source.setSession(person, payload.workItemId, payload.sessionId);
    reply("ack", {});
  },
  async journal({ ctx, person, payload, reply }) {
    await ctx.opts.source.journal(person, payload.workItemId, payload.text);
    reply("ack", {});
  },
  async handback({ ctx, person, payload, reply }) {
    const { workItemId, ...result } = payload;
    await ctx.opts.source.handBack(person, workItemId, result);
    await ctx.opts.messaging?.onHandBack?.(workItemId, result.status);
    reply("ack", {});
    ctx.deliver(person);
  },
  async fail({ ctx, person, payload, reply }) {
    await ctx.opts.source.fail(person, payload.workItemId, payload.reason);
    reply("ack", {});
    ctx.deliver(person);
  },
  async work_list({ ctx, person, payload, reply }) {
    const items = await ctx.opts.source.list(person, defined({ workItemId: payload.workItemId }));
    reply("work_list_result", { items });
  },
  async work_move({ ctx, person, payload, reply }) {
    const item = await ctx.opts.source.move(person, payload.workItemId, payload.status);
    reply("work_move_result", { item });
  },
  async work_place({ ctx, person, payload, reply }) {
    const { workItemId, position, relativeTo } = payload;
    const item = await ctx.opts.source.place(person, workItemId, position, relativeTo);
    reply("work_move_result", { item });
  },
};
