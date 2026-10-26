import type { Logger } from "@outstaff/core";
import type { Filed } from "@outstaff/protocol";
import type { FiledWhat } from "./chat.types.js";
import type { Offer } from "../office-client/index.js";
import type { AgentEnv } from "../verbs/types.js";
import type { Attachment } from "./types.js";
import { saveTicketFiles } from "./attachments.js";
import { safeId } from "../repos/workspaces.js";
import { join } from "node:path";
import type { WorkLoopOptions, ItemEnv } from "./loop.types.js";
import { reason } from "./reason.js";

/**
 * Files people shared with the request or attached to its tickets: data, downloaded into the item's scratch
 * directory (deleted with it) so the model can read them.
 */
export async function itemFiles(
  opts: WorkLoopOptions,
  offer: Offer,
  log: Logger,
): Promise<{ attachments: Attachment[]; ticketFiles: Record<string, Attachment[]> }> {
  const id = offer.workItem.id;
  const scratch = opts.env.layout ? join(opts.env.layout.scratchDir, safeId(id)) : undefined;
  const attachments: Attachment[] =
    scratch && offer.workItem.origin?.files?.length && opts.chat
      ? await opts.chat.attachments(offer, join(scratch, "files")).catch((err) => {
          log.warn("could not read the files of a chat message", {
            workItemId: id,
            error: reason(err),
          });

          return [];
        })
      : [];

  const ticketKeys = offer.context.subjects.filter((s) => s.type === "ticket").map((s) => s.ref);
  const ticketFiles =
    scratch && ticketKeys.length
      ? await saveTicketFiles(opts.env.tracker, ticketKeys, join(scratch, "tickets"), log)
      : {};

  return { attachments, ticketFiles };
}

/**
 * The verbs' environment for one item. It notes the tickets the agent moves, whether it asked a question that is
 * still open, and whether a chat session filed its request as work.
 */
export function itemEnv(
  opts: WorkLoopOptions,
  offer: Offer,
  {
    attachments,
    ticketFiles,
  }: { attachments: Attachment[]; ticketFiles: Record<string, Attachment[]> },
  log: Logger,
): ItemEnv {
  const id = offer.workItem.id;
  // A chat session that filed its request as work tells the requester in the thread. The work reports its own result.
  let filedWork = false;
  const filed = async (workItemId: string, what: FiledWhat, f: Filed) => {
    if (workItemId !== id || !offer.workItem.origin) {
      return;
    }

    filedWork = true;
    await opts.chat?.acknowledge(offer, what, f).catch((err) => {
      log.warn("could not acknowledge in chat", { workItemId: id, error: reason(err) });
    });
  };

  // The ask verb reports a question that is still open; the item then waits for the answer instead of being done.
  let asked = false;
  // The last status the agent moved each ticket to in this run; a ticket it left blocked is handed back as blocked.
  const moved = new Map<string, string>();
  const baseTracker = opts.env.tracker;
  const tracker = baseTracker
    ? Object.create(baseTracker, {
        transition: {
          value: async (...args: Parameters<typeof baseTracker.transition>) => {
            const issue = await baseTracker.transition(...args);
            moved.delete(args[0]);
            moved.set(args[0], args[1]);
            return issue;
          },
        },
      })
    : undefined;

  const base = opts.env.office;
  const files = {
    ...(attachments.length ? { attachments } : {}),
    ...(Object.keys(ticketFiles).length ? { ticketFiles } : {}),
  };

  const env: AgentEnv = base
    ? {
        ...opts.env,
        ...files,
        ...(tracker ? { tracker } : {}),
        office: {
          ...base,
          async ask(q) {
            const r = await base.ask(q);
            asked ||= r.status === "pending";
            return r;
          },
          async linkTicket(workItemId, ticket, request) {
            const r = await base.linkTicket(workItemId, ticket, request);
            await filed(workItemId, { key: ticket, title: ticket }, r);
            return r;
          },
          async attachWork(workItemId, request) {
            const r = await base.attachWork(workItemId, request);
            await filed(workItemId, { attached: r.attached, title: r.item.title }, r);
            return r;
          },
          async queueWork(workItemId, request) {
            const r = await base.queueWork(workItemId, request);
            await filed(workItemId, { title: request.title }, r);
            return r;
          },
        },
      }
    : tracker
      ? { ...opts.env, ...files, tracker }
      : { ...opts.env, ...files };

  return { env, moved, asked: () => asked, filedWork: () => filedWork };
}
