import { ProtocolError } from "#/protocol/errors.js";
import type { RequestHandlers } from "#/protocol/types.js";

/** The service, or the `unsupported` refusal when this office runs without it. */
function required<T>(service: T | undefined, refusal: string): T {
  if (!service) {
    throw new ProtocolError("unsupported", refusal);
  }

  return service;
}

const NO_QUESTIONS = "This office does not route questions.";
const NO_PRS = "This office does not track tickets and pull requests.";

/** The optional services: usage and doctor reports, questions between people, documents, act results, and tickets with their pull requests. */
export const serviceHandlers: RequestHandlers = {
  async usage({ ctx, person, payload, reply }) {
    const usage = required(ctx.opts.usage, "This office does not take usage reports.");
    await usage.report(person, payload.windows);
    reply("ack", {});
  },
  async doctor_report({ ctx, person, payload, reply }) {
    const doctor = required(ctx.opts.doctor, "This office does not take doctor reports.");
    await doctor.report(person, payload.checks);
    reply("ack", {});
  },
  async ask({ ctx, person, payload, reply }) {
    reply("ask_result", await required(ctx.opts.messaging, NO_QUESTIONS).ask(person, payload));
  },
  async answer({ ctx, person, payload, reply }) {
    const messaging = required(ctx.opts.messaging, NO_QUESTIONS);
    await messaging.answer(person, payload.questionId, payload.answer);
    reply("ack", {});
  },
  async resolve_role({ ctx, person, payload, reply }) {
    const messaging = required(ctx.opts.messaging, NO_QUESTIONS);
    reply("resolve_role_result", { handle: await messaging.resolveRole(person, payload.role) });
  },
  async roster({ ctx, reply }) {
    const { messaging, source } = ctx.opts;
    reply(
      "roster_result",
      messaging?.roster ? await messaging.roster() : { members: await source.roster() },
    );
  },
  async doc_link({ ctx, person, payload, reply }) {
    const docs = required(ctx.opts.docs, "This office does not track documents.");
    await docs.link(person, payload.workItemId, payload.doc, payload.ticket);
    reply("ack", {});
  },
  async work_made({ ctx, person, payload, reply }) {
    await required(ctx.opts.made, "This office does not record what agents make.").made(
      person,
      payload,
    );

    reply("ack", {});
  },
  async notes_changed({ ctx, person, payload, reply }) {
    await required(ctx.opts.notes, "This office does not take notes reports.").changed(
      person,
      payload,
    );

    reply("ack", {});
  },
  async act_result({ ctx, person, payload, reply }) {
    await required(ctx.opts.acts, "This office sends no acts.").result(person, payload);
    reply("ack", {});
  },
  async ticket_prs({ ctx, payload, reply }) {
    reply("ticket_prs_result", await required(ctx.opts.tickets, NO_PRS).forDraft(payload));
  },
  async pr_list({ ctx, person, payload, reply }) {
    reply("pr_list_result", await required(ctx.opts.tickets, NO_PRS).list(person, payload));
  },
  async ticket_usage({ ctx, payload, reply }) {
    const usage = required(ctx.opts.ticketUsage, "This office does not track usage.");
    reply("ticket_usage_result", await usage.read(payload.ticket));
  },
  async ci_log({ ctx, person, payload, reply }) {
    const logs = required(ctx.opts.ciLogs, "This office does not read check logs.");
    reply("ci_log_result", await logs.read(person, payload));
  },
  async recall({ ctx, person, payload, reply }) {
    const recall = required(ctx.opts.recall, "This office keeps no history to recall.");
    reply("recall_result", await recall.search(person, payload));
  },
};
