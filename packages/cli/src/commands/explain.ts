import { defineCommand } from "#/define.js";
import type { Context } from "#/types.js";

/**
 * `@outstaff/office` is an optional peer of the CLI: the agent image ships the CLI without it, so its database drivers
 * are not installed there. It is loaded only when this command runs, where the office store is reachable.
 */
const importOffice = () => import("@outstaff/office");

type Options = {
  store?: string;
  recent?: string;
  json?: boolean;
};

/** What to print: the latest traces, or one event's trace. */
type Mode = { kind: "recent"; limit: number } | { kind: "one"; id: string };

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

/** What the options ask for, or why they do not make sense. */
function modeOf(options: Options, args: string[]): Mode | string {
  const recent = recentOf(options.recent);
  if (recent === false) {
    return "--recent takes a whole number above 0.";
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
  if (mode.kind === "recent") {
    const list = await traces.list({ limit: mode.limit });
    const line = (t: (typeof list)[number]) =>
      `${t.event.at}  ${t.event.type}  ${t.event.id}\n    ${t.decisions.map(office.describeDecision).join("; ")}\n`;

    ctx.out(asJson ? json(list) : list.map(line).join(""));
    return 0;
  }

  const trace = await traces.get(mode.id);
  if (!trace) {
    return fail(ctx, `No trace for ${mode.id}. Is it an event id as the office logs it?`);
  }

  ctx.out(asJson ? json(trace) : `${office.formatTrace(trace)}\n`);
  return 0;
}

async function explain(ctx: Context, options: Options, args: string[]): Promise<number> {
  const url = options.store ?? ctx.env["OUTSTAFF_STORE_URL"];
  if (!url) {
    return fail(ctx, "Give the office store with --store or OUTSTAFF_STORE_URL.");
  }

  const mode = modeOf(options, args);
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
    "Reads the trace the office recorded for one event and prints every policy of the event pipeline that listens to it: whether it matched, why, and for one that did not, its first failing condition. Then the decisions: wake, act or drop, with what each act did and what each wake's bundle carried. The event id is the office's <source>:<external-id>, as the office logs it; --recent lists the latest traced events with their ids. Nothing is changed, and the store is not migrated.",
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
  run: (ctx, options, args) => explain(ctx, options, args),
});
