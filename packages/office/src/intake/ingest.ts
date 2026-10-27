import { PortError } from "@outstaff/core";
import type { DocEvent, TrackerEvent, VcsEvent, WorkflowEvent } from "@outstaff/core";
import { prLabel, subjectLabel } from "../log.js";
import {
  normalizeDocEvent,
  normalizeTrackerEvent,
  normalizeVcsEvent,
  resolveMentions,
} from "./normalize.js";
import type { Ingest, IngestOptions, IntakeMeta, StoredPayload } from "./types.js";

const TRANSIENT = new Set(["rate_limited", "unavailable"]);

/** The adapters re-read the last 5 minutes of each feed, so an id older than that no longer comes back. */
const UNMAPPED_MEMORY_MS = 5 * 60_000;
const UNMAPPED_MEMORY_CAP = 5_000;

/** Classifies, records and passes on the events the sources read. */
export function createIngest(opts: IngestOptions): Ingest {
  const { store, clock, logger, trust, mentions } = opts;

  // Feeds are re-read with an overlap, so an unmapped event comes back on every poll. It is logged at info
  // once per event id and at debug after that. Kept in memory: after a restart it may be logged at info again.
  const seenUnmapped = new Map<string, number>();
  const firstSighting = (source: string, externalId: string): boolean => {
    const now = clock.now().getTime();
    for (const [key, at] of seenUnmapped) {
      if (now - at <= UNMAPPED_MEMORY_MS && seenUnmapped.size < UNMAPPED_MEMORY_CAP) {
        break;
      }

      seenUnmapped.delete(key);
    }

    const key = `${source}:${externalId}`;
    if (seenUnmapped.has(key)) {
      return false;
    }

    seenUnmapped.set(key, now);
    return true;
  };

  // Classify first (may throw on a transient failure and abort the page), then dedupe-and-record, then deliver.
  const ingest = async (
    source: IntakeMeta["source"],
    raw: { externalId: string; type: string },
    subject: string,
    normalize: () => Promise<{ event: WorkflowEvent; trusted: boolean } | undefined>,
  ) => {
    const dropped = (reason: string, level: "info" | "debug" = "debug") =>
      logger[level](`intake: dropped ${source} ${raw.type} on ${subject}: ${reason}`, {
        source,
        type: raw.type,
        subject,
        externalId: raw.externalId,
        reason,
      });

    const result = await normalize();
    if (!result) {
      dropped(
        "the office does not map this event type",
        firstSighting(source, raw.externalId) ? "info" : "debug",
      );

      return;
    }

    const payload: StoredPayload = { raw, event: result.event, trusted: result.trusted };
    const fresh = await store.recordEvent({
      source,
      externalId: raw.externalId,
      type: result.event.type,
      payload,
    });

    const { event } = result;
    const where = subjectLabel(event.subject);
    if (!fresh) {
      dropped("duplicate of an event already recorded");
      return;
    }

    logger.info(
      `intake: recorded ${source} ${event.type} on ${where} by ${event.actor.id} (${result.trusted ? "trusted" : "untrusted"})`,
      {
        source,
        type: event.type,
        subject: where,
        actor: event.actor.id,
        actorKind: event.actor.kind,
        trusted: result.trusted,
      },
    );

    await opts.drain();
  };

  // A submitted review brings the inline comments it was written with; they are stored with the event.
  const withInlineComments = async (event: VcsEvent, mapped: WorkflowEvent) => {
    const id = event.type === "pr.review_submitted" ? event.data["reviewId"] : undefined;
    if (id === undefined || id === null) {
      return;
    }

    try {
      const found = await opts.vcs.reviewComments(event.repo, event.number, String(id));
      if (found.length > 0) {
        mapped.data["comments"] = found.map((c) => ({
          id: c.id,
          path: c.path,
          ...(c.line === undefined ? {} : { line: c.line }),
          body: c.body,
          ...(c.url ? { url: c.url } : {}),
          ...(c.threadId ? { threadId: c.threadId } : {}),
        }));
      }
    } catch (error) {
      // Transient failures abort the page so it is retried; the cursor does not move.
      if (!(error instanceof PortError) || TRANSIENT.has(error.code)) {
        throw error;
      }

      logger.warn(`intake: inline comments of review ${String(id)} not read: ${error.message}`, {
        review: String(id),
        code: error.code,
      });
    }
  };

  return {
    logUnmapped(source, page) {
      for (const u of page.unmapped ?? []) {
        const subject = u.repo ? `${u.repo.owner}/${u.repo.name}` : source;
        const level = firstSighting(source, u.externalId) ? "info" : "debug";
        logger[level](
          `intake: dropped ${source} ${u.type} on ${subject}: the adapter does not map this event type`,
          {
            source,
            type: u.type,
            subject,
            externalId: u.externalId,
            reason: "the adapter does not map this event type",
          },
        );
      }
    },

    vcs: (event: VcsEvent) =>
      ingest("vcs", event, prLabel(event), async () => {
        const actor = await trust.vcsActor(event.repo, event.actor);
        const mapped = normalizeVcsEvent(event, actor);
        if (mapped && actor.kind === "human") {
          await withInlineComments(event, mapped);
        }

        return mapped && { event: mapped, trusted: actor.kind !== "human" || actor.trusted };
      }),

    tracker: (event: TrackerEvent) =>
      ingest("tracker", event, event.key, async () => {
        const actor = trust.trackerActor(event.actor);
        const mapped = normalizeTrackerEvent(event, actor);
        if (mapped) {
          resolveMentions(mapped, mentions);
        }

        return mapped && { event: mapped, trusted: actor.kind !== "human" || actor.trusted };
      }),

    doc: (event: DocEvent, ticket: string | undefined) =>
      ingest("knowledge", event, event.doc, async () => {
        const actor = trust.trackerActor(event.actor);
        const mapped = normalizeDocEvent(event, actor, ticket);
        resolveMentions(mapped, mentions);
        return { event: mapped, trusted: actor.kind !== "human" || actor.trusted };
      }),
  };
}
