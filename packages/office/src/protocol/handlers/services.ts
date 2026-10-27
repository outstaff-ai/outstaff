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

/** The optional services: usage and doctor reports, questions between people, documents, and tickets with their pull requests. */
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
  async roster({ ctx, reply }) {
    const { messaging, source } = ctx.opts;
    reply(
      "roster_result",
      messaging?.roster ? await messaging.roster() : { members: await source.roster() },
    );
  },
  async doc_link({ ctx, person, payload, reply }) {
    const docs = required(ctx.opts.docs, "This office does not track documents.");
    await docs.link(person, payload.workItemId, payload.doc);
    reply("ack", {});
  },
  async ticket_prs({ ctx, payload, reply }) {
    const tickets = required(
      ctx.opts.tickets,
      "This office does not track tickets and pull requests.",
    );

    reply("ticket_prs_result", await tickets.forDraft(payload));
  },
};
