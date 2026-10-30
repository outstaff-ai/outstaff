import { blockedNotify } from "@outstaff/core";
import type { ChatOrigin, QueuedReport } from "@outstaff/protocol";
import { ProtocolError } from "#/protocol/errors.js";
import type { WorkItem } from "#/store/types.js";
import type { ChatDeskOptions, ChatRequests } from "./desk.types.js";
import { CHAT_ORIGIN_SUBJECT, readOrigin, threadsOf } from "./origin.js";
import { createReportQueue } from "./pending.js";
import type { ChatOriginRecord } from "./types.js";

export const PM_ROLE = "pm";

const reportId = (r: { itemId: string; key: string }) => `${r.itemId}:${r.key}`;

/** Work that answers something and changes no ticket: a blocked end of it tells no requester. */
const SILENT_KINDS = new Set(["asked", "doc_feedback"]);

const firstLine = (text: string, max = 80) => {
  const line = text.split("\n", 1)[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

type Reports = Pick<ChatRequests, "handedBack" | "queued" | "posted" | "blocked" | "report">;

/**
 * The reports an agent owes a requester: the result of chat work, and blocked work when the agent is the one to tell.
 * The agent posts them as itself; the office only keeps them until the agent confirms.
 */
export function createReports(opts: ChatDeskOptions): Reports {
  const { store } = opts;
  const clock = opts.clock;
  const reports = createReportQueue(store);

  /**
   * Whether the blocked agent reports blocked work to the requester itself. Always in the thread a human asked in (the
   * agent replying there is not a notification); for work without a chat origin only when the team leaves it to the
   * agent (`policies.hand_back.blocked_notify`), or the blocked agent is the PM, who has nobody to leave it to.
   */
  const reportsBlocked = (item: WorkItem, origin: ChatOriginRecord | undefined) =>
    origin !== undefined ||
    blockedNotify(opts.team) === "agent" ||
    opts.team.people.some((p) => p.handle === item.person && p.role === PM_ROLE);

  const claim = async (item: WorkItem, origin: ChatOriginRecord, kind: string) => {
    // Each request a chat session files is acknowledged once, so a message with two requests gets two replies.
    const key =
      kind === "ack"
        ? `ack:${origin.requests?.length ?? 0}`
        : kind === "failed"
          ? kind
          : await claimKey(item, kind);

    if (origin.claimed.includes(key)) {
      return false;
    }

    await store.upsertSubject(CHAT_ORIGIN_SUBJECT, item.id, {
      ...origin,
      claimed: [...origin.claimed, key],
    });

    return true;
  };

  const claimKey = async (item: WorkItem, kind: string) =>
    `${kind}:${(await store.listRuns(item.id)).at(-1)?.id ?? "0"}`;

  /** Where the agent posts a report: the chat threads of the item, else the requester's direct message. */
  async function placeOf(
    item: WorkItem,
    origin: ChatOriginRecord | undefined,
    kind: "result" | "blocked" | "ack" | "failed",
  ): Promise<{ requester: string; threads?: ChatOrigin[]; direct?: string } | undefined> {
    if (origin) {
      return { requester: origin.requester.id, threads: threadsOf(origin) };
    }

    const direct = kind === "blocked" ? await opts.requesterChat?.(item) : undefined;
    return direct ? { requester: direct, direct } : undefined;
  }

  return {
    async handedBack(item, result) {
      const origin = await readOrigin(store, item.id);
      const kind =
        item.status === "done" ? "result" : item.status === "blocked" ? "blocked" : undefined;

      // A session that filed its request as work has nothing to report; the work reports its own result.
      if (!kind || !clock || origin?.filed) {
        return;
      }

      // The result is for the chat thread that asked; a blocked item is reported when the agent is the one to do it.
      // Answering someone else's question or a document comment is not the work the requester waits for.
      if (
        kind === "result"
          ? !origin
          : !reportsBlocked(item, origin) || (!origin && SILENT_KINDS.has(item.kind))
      ) {
        return;
      }

      const key = await claimKey(item, kind);
      // A retried hand-back finds it queued, or the agent already reported it.
      if (origin?.claimed.includes(key)) {
        return;
      }

      await reports.add(item.person, {
        itemId: item.id,
        key,
        kind,
        summary: result.summary,
        links: result.links,
        at: clock.now().toISOString(),
      });
    },

    async queued(person) {
      const out: QueuedReport[] = [];
      for (const entry of await reports.list(person)) {
        const item = await store.getItem(entry.itemId);
        const origin = item && (await readOrigin(store, item.id));
        const ended = item?.status === (entry.kind === "result" ? "done" : "blocked");
        // The ending is gone (the item was retried) or the agent posted it itself already.
        if (!item || !ended || origin?.claimed.includes(entry.key)) {
          await reports.settle(person, entry.itemId, entry.key);
          continue;
        }

        const where = await placeOf(item, origin, entry.kind);
        if (!where) {
          await reports.settle(person, entry.itemId, entry.key);
          continue;
        }

        out.push({
          id: reportId(entry),
          workItemId: item.id,
          kind: entry.kind,
          text: entry.summary,
          ...where,
          links: [...entry.links, ...(await opts.linksOf(item))],
        });
      }

      return out;
    },

    async posted(person, workItemId, id) {
      const entry = (await reports.list(person)).find(
        (r) => r.itemId === workItemId && reportId(r) === id,
      );

      // Confirmed twice, or the report was settled another way: nothing left to do.
      if (!entry) {
        return;
      }

      const origin = await readOrigin(store, workItemId);
      if (origin && !origin.claimed.includes(entry.key)) {
        await store.upsertSubject(CHAT_ORIGIN_SUBJECT, workItemId, {
          ...origin,
          claimed: [...origin.claimed, entry.key],
        });
      }

      await reports.settle(person, workItemId, entry.key);
    },

    async blocked(item, reason) {
      const origin = await readOrigin(store, item.id);
      // The thread a human asked in always gets its agent's reply; other work only when the agent reports it.
      if (
        !clock ||
        origin?.filed ||
        !reportsBlocked(item, origin) ||
        (!origin && SILENT_KINDS.has(item.kind))
      ) {
        return;
      }

      const key = `${await claimKey(item, "blocked")}:${clock.now().toISOString()}`;
      await reports.add(item.person, {
        itemId: item.id,
        key,
        kind: "blocked",
        summary: firstLine(reason, 200),
        links: [],
        at: clock.now().toISOString(),
      });

      opts.push?.(item.person);
    },

    async report(person, workItemId, kind) {
      const item = await store.getItem(workItemId);
      if (!item || item.person !== person) {
        throw new ProtocolError("unknown_item", `No work item ${workItemId} for ${person}.`);
      }

      const origin = await readOrigin(store, item.id);
      const ended =
        kind === "result"
          ? item.status === "done"
          : kind === "blocked"
            ? item.status === "blocked" && reportsBlocked(item, origin)
            : true;

      if (!ended) {
        return { post: false, links: [] };
      }

      const key = kind === "result" || kind === "blocked" ? await claimKey(item, kind) : undefined;
      if (origin) {
        if (!(await claim(item, origin, kind))) {
          return { post: false, links: [] };
        }
      } else if (kind !== "blocked" || (await reports.done(person, item.id, key!))) {
        // Only a blocked item without a chat thread has someone to tell: the requester, in a direct message.
        return { post: false, links: [] };
      }

      const where = await placeOf(item, origin, kind);
      if (!where) {
        return { post: false, links: [] };
      }

      if (key) {
        await reports.settle(person, item.id, key);
      }

      return { post: true, ...where, links: await opts.linksOf(item) };
    },
  };
}
