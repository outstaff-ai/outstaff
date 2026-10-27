import { defineCommand } from "../define.js";
import type { Context } from "../types.js";

/**
 * `@outstaff/office` is an optional peer of the CLI: the agent image ships the CLI without it, so its database drivers
 * are not installed there. It is loaded only when this command runs, where the office store is reachable.
 */
const importOffice = () => import("@outstaff/office");

/** A time to compare from: a duration back from now (`30m`, `24h`, `7d`) or an ISO-8601 time; undefined if neither. */
export function sinceTime(raw: string, now: Date): string | undefined {
  const ago = /^(\d+)(m|h|d)$/.exec(raw);
  if (ago) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[ago[2] as "m" | "h" | "d"];
    return new Date(now.getTime() - Number(ago[1]) * unit).toISOString();
  }

  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

type Options = {
  store?: string;
  recent?: string;
  compare?: boolean;
  since?: string;
  json?: boolean;
};

/** What to print: a comparison over many events, the latest traces, or one event's trace. */
type Mode =
  | { kind: "compare"; since?: string | undefined }
  | { kind: "recent"; limit: number }
  | { kind: "one"; id: string };

type Office = Awaited<ReturnType<typeof importOffice>>;
type Traces = ReturnType<Office["createStoreTraceStore"]>;

const fail = (ctx: Context, message: string) => {
  ctx.err(`error    ${message}\n`);
  return 1;
};

function recentOf(raw: string | undefined): number | undefined | false {
  if (raw === undefined) {
    return undefined;
  }

  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : false;
}

/** The time `--since` names, `false` when it names none, undefined without it. */
function sinceOf(ctx: Context, raw: string | undefined): string | undefined | false {
  if (raw === undefined) {
    return undefined;
  }

  return sinceTime(raw, ctx.now?.() ?? new Date()) ?? false;
}

/** What the options ask for, or why they do not make sense. */
function modeOf(ctx: Context, options: Options, args: string[]): Mode | string {
  const recent = recentOf(options.recent);
  const since = sinceOf(ctx, options.since);
  if (recent === false) {
    return "--recent takes a whole number above 0.";
  }

  if (since === false) {
    return "--since takes a duration such as 24h or 7d, or an ISO-8601 time.";
  }

  if (options.compare) {
    return { kind: "compare", since };
  }

  if (recent !== undefined) {
    return { kind: "recent", limit: recent };
  }

  return args[0]
    ? { kind: "one", id: args[0] }
    : "Give an event id, or --recent <n> to list the latest ones.";
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Prints what the mode asks for; returns the exit code. */
async function show(
  ctx: Context,
  office: Office,
  traces: Traces,
  mode: Mode,
  asJson: boolean,
): Promise<number> {
  if (mode.kind === "compare") {
    const summary = await office.compareRange(traces, mode.since ? { since: mode.since } : {});
    ctx.out(asJson ? json(summary) : `${office.formatSummary(summary)}\n`);
    return 0;
  }

  if (mode.kind === "recent") {
    const list = await traces.list({ limit: mode.limit });
    const line = (t: (typeof list)[number]) =>
      `${t.event.at}  ${t.event.type}  ${t.event.id}\n    ${t.decisions.map(office.describeDecision).join("; ")}\n`;

    ctx.out(asJson ? json(list) : list.map(line).join(""));
    return 0;
  }

  const trace = await traces.get(mode.id);
  if (!trace) {
    return fail(
      ctx,
      `No trace for ${mode.id}. Is the office running with office.pipeline: shadow?`,
    );
  }

  ctx.out(asJson ? json(trace) : `${office.formatTrace(trace)}\n`);
  return 0;
}

async function explain(ctx: Context, options: Options, args: string[]): Promise<number> {
  const url = options.store ?? ctx.env["OUTSTAFF_STORE_URL"];
  if (!url) {
    return fail(ctx, "Give the office store with --store or OUTSTAFF_STORE_URL.");
  }

  const mode = modeOf(ctx, options, args);
  if (typeof mode === "string") {
    return fail(ctx, mode);
  }

  const office = await (ctx.loadOffice ?? importOffice)().catch(() => undefined);
  if (!office) {
    return fail(
      ctx,
      "ost explain reads the office store and needs @outstaff/office installed next to the CLI.",
    );
  }

  let store: Awaited<ReturnType<Office["openStore"]>> | undefined;
  try {
    store = await office.openStore(url, { migrate: false });
    return await show(
      ctx,
      office,
      office.createStoreTraceStore(store),
      mode,
      options.json === true,
    );
  } catch (error) {
    return fail(ctx, `Could not read the office store: ${(error as Error).message}`);
  } finally {
    await store?.close();
  }
}

export const explainEvent = defineCommand<Options>({
  name: "explain",
  summary: "Show what the event pipeline decided for an event, and why.",
  description:
    "Proposed (decision 0016). Reads the trace the office recorded for one event while running the event pipeline in shadow mode (office.pipeline: shadow) and prints every policy that listens to the event: whether it matched, why, and for one that did not, its first failing condition. Then the decisions: wake, act or drop, and in shadow mode what the engine applied for the same event and how the two compare. --compare sums that up over many events: how many agree and differ, the differences by kind and by policy, and the events that differ. The event id is the office's <source>:<external-id>, as the office logs it; --recent lists the latest traced events with their ids. Nothing is changed, and the store is not migrated.",
  args: "[event-id]",
  options: [
    {
      flags: "--store <url>",
      description:
        "The office store: postgres://..., sqlite:///path/office.db. Defaults to OUTSTAFF_STORE_URL.",
    },
    { flags: "--recent <n>", description: "List the n latest traced events instead." },
    {
      flags: "--compare",
      description: "Compare the engine and the pipeline over the traced events instead.",
    },
    {
      flags: "--since <when>",
      description:
        "With --compare: only events since then, a duration back from now (30m, 24h, 7d) or an ISO-8601 time.",
    },
  ],
  examples: [
    "ost explain vcs:pr.merged:acme-example/shop#41 --store sqlite:///var/lib/outstaff/office.db",
    "ost explain --recent 20",
    "ost explain --compare --since 24h",
  ],
  exitCodes: [
    "0: the trace, the list or the comparison was printed",
    "1: no store is given or it cannot be read, no event id is given, the event has no trace, or --since is not a time",
  ],
  run: (ctx, options, args) => explain(ctx, options, args),
});
