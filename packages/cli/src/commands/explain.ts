import { defineCommand } from "../define.js";

/**
 * `@outstaff/office` is an optional peer of the CLI: the agent image ships the CLI without it, so its database drivers
 * are not installed there. It is loaded only when this command runs, where the office store is reachable.
 */
const importOffice = () => import("@outstaff/office");

export const explainEvent = defineCommand<{ store?: string; recent?: string }>({
  name: "explain",
  summary: "Show what the event pipeline decided for an event, and why.",
  description:
    "Proposed (decision 0016). Reads the trace the office recorded for one event while running the event pipeline in shadow mode (office.pipeline: shadow) and prints every policy that listens to the event: whether it matched, why, and for one that did not, its first failing condition. Then the decisions: wake, act or drop. The event id is the office's <source>:<external-id>, as the office logs it; --recent lists the latest traced events with their ids. Nothing is changed, and the store is not migrated.",
  args: "[event-id]",
  options: [
    {
      flags: "--store <url>",
      description:
        "The office store: postgres://..., sqlite:///path/office.db. Defaults to OUTSTAFF_STORE_URL.",
    },
    { flags: "--recent <n>", description: "List the n latest traced events instead." },
  ],
  examples: [
    "ost explain vcs:pr.merged:acme-example/shop#41 --store sqlite:///var/lib/outstaff/office.db",
    "ost explain --recent 20",
  ],
  exitCodes: [
    "0: the trace or the list was printed",
    "1: no store is given or it cannot be read, no event id is given, or the event has no trace",
  ],
  async run(ctx, options, args) {
    const url = options.store ?? ctx.env["OUTSTAFF_STORE_URL"];
    const id = args[0];
    const recent = options.recent === undefined ? undefined : Number(options.recent);
    if (!url) {
      ctx.err("error    Give the office store with --store or OUTSTAFF_STORE_URL.\n");
      return 1;
    }

    if (recent !== undefined && !(Number.isInteger(recent) && recent > 0)) {
      ctx.err("error    --recent takes a whole number above 0.\n");
      return 1;
    }

    if (recent === undefined && !id) {
      ctx.err("error    Give an event id, or --recent <n> to list the latest ones.\n");
      return 1;
    }

    let office: Awaited<ReturnType<typeof importOffice>>;
    try {
      office = await (ctx.loadOffice ?? importOffice)();
    } catch {
      ctx.err(
        "error    ost explain reads the office store and needs @outstaff/office installed next to the CLI.\n",
      );

      return 1;
    }

    const { createStoreTraceStore, describeDecision, formatTrace, openStore } = office;
    let store;
    try {
      store = await openStore(url, { migrate: false });
      const traces = createStoreTraceStore(store);
      if (recent !== undefined) {
        const list = await traces.list({ limit: recent });
        if (options.json) {
          ctx.out(`${JSON.stringify(list, null, 2)}\n`);
        } else {
          for (const t of list) {
            const decided = t.decisions.map(describeDecision).join("; ");
            ctx.out(`${t.event.at}  ${t.event.type}  ${t.event.id}\n    ${decided}\n`);
          }
        }

        return 0;
      }

      const trace = await traces.get(id!);
      if (!trace) {
        ctx.err(
          `error    No trace for ${id}. Is the office running with office.pipeline: shadow?\n`,
        );

        return 1;
      }

      ctx.out(options.json ? `${JSON.stringify(trace, null, 2)}\n` : `${formatTrace(trace)}\n`);
      return 0;
    } catch (error) {
      ctx.err(`error    Could not read the office store: ${(error as Error).message}\n`);
      return 1;
    } finally {
      await store?.close();
    }
  },
});
