import type { IntakeMeta, PollSource, SourcesOptions, WebhookParser } from "./types.js";

const CURSOR_KEY = "events";

/** How many documents one poll of the knowledge base reads the comments of. */
export const DOC_POLL_LIMIT = 25;

/** The sources intake polls: the code host, and the tracker and knowledge base when the team has them. */
export function pollSources(opts: SourcesOptions): PollSource[] {
  const { store, ports, team, repos, logger, ingest } = opts;

  // With no stored cursor the source returns its recent history; that is not news, so only remember where "now" is.
  const setBaseline = async (source: IntakeMeta["source"], cursor: string) => {
    await store.setCursor(source, CURSOR_KEY, cursor);
    logger.info(`intake: baseline set for ${source}`);
  };

  const sources: PollSource[] = [
    {
      name: "vcs",
      async poll() {
        const cursor = await store.getCursor("vcs", CURSOR_KEY);
        const page = await ports.vcs.events(repos, cursor);
        if (cursor === undefined) {
          await setBaseline("vcs", page.cursor);
          return;
        }

        ingest.logUnmapped("vcs", page);
        for (const event of page.events) {
          await ingest.vcs(event);
        }

        await store.setCursor("vcs", CURSOR_KEY, page.cursor);
      },
    },
  ];

  const { tracker } = ports;
  if (tracker && team.integrations.tracker) {
    sources.push({
      name: "tracker",
      async poll() {
        const cursor = await store.getCursor("tracker", CURSOR_KEY);
        const page = await tracker.events(cursor);
        if (cursor === undefined) {
          await setBaseline("tracker", page.cursor);
          return;
        }

        ingest.logUnmapped("tracker", page);
        for (const event of page.events) {
          await ingest.tracker(event);
        }

        await store.setCursor("tracker", CURSOR_KEY, page.cursor);
      },
    });
  }

  const { knowledge } = ports;
  if (knowledge && opts.docs) {
    const watched = opts.docs;
    sources.push({
      name: "knowledge",
      always: true,
      async poll() {
        const cursor = await store.getCursor("knowledge", CURSOR_KEY);
        const docs = watched.open(DOC_POLL_LIMIT);
        // Nothing to read yet: the first call still happens, so that what is written before the first document is
        // not mistaken for the baseline later.
        if (cursor !== undefined && docs.length === 0) {
          return;
        }

        const page = await knowledge.events(
          docs.map((d) => d.id),
          cursor,
        );

        if (cursor === undefined) {
          await setBaseline("knowledge", page.cursor);
          return;
        }

        const ticketOf = new Map(docs.map((d) => [d.id, d.ticket]));
        for (const event of page.events) {
          await ingest.doc(event, ticketOf.get(event.doc));
        }

        await store.setCursor("knowledge", CURSOR_KEY, page.cursor);
      },
    });
  }

  return sources;
}

/** The webhook receivers of the adapters that parse webhooks. */
export function webhookParsers(
  ports: SourcesOptions["ports"],
  ingest: SourcesOptions["ingest"],
): Record<string, WebhookParser> {
  const { tracker } = ports;
  const parsers: Record<string, WebhookParser> = {};
  if (ports.vcs.parseWebhook) {
    parsers["vcs"] = async (headers, body) => {
      for (const event of await ports.vcs.parseWebhook!(headers, body)) {
        await ingest.vcs(event);
      }
    };
  }

  if (tracker?.parseWebhook) {
    parsers["tracker"] = async (headers, body) => {
      for (const event of await tracker.parseWebhook!(headers, body)) {
        await ingest.tracker(event);
      }
    };
  }

  return parsers;
}
