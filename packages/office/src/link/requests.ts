import type { LinkErrorCode, LinkMethod, LinkRequest, LinkResponse } from "@outstaff/protocol";
import type { Trace } from "#/pipeline/trace.types.js";
import { countActivity } from "./activity.js";
import { findEvents } from "./events.js";
import { findItem } from "./item.js";
import { findItems } from "./items.js";
import type { OfficeLinkOptions } from "./link.types.js";
import { listPeople } from "./people.js";
import { present } from "./present.js";
import { countEvents } from "./totals.js";

const error = (id: string, code: LinkErrorCode, message: string): LinkResponse => ({
  id,
  error: { code, message },
});

type Params<M extends LinkRequest["method"]> = Extract<LinkRequest, { method: M }>["params"];

const people = async (opts: OfficeLinkOptions, id: string): Promise<LinkResponse> => ({
  id,
  result: { at: opts.clock.now().toISOString(), people: await listPeople(opts) },
});

async function events(
  opts: OfficeLinkOptions,
  id: string,
  params: Params<"events">,
): Promise<LinkResponse> {
  const filter = params ?? {};
  const [found, total] = await Promise.all([
    findEvents(opts.store, filter),
    countEvents(opts.store, filter),
  ]);

  return {
    id,
    result: { ...found, total, events: found.events.map((t) => present(t, opts.links)) },
  };
}

async function event(opts: OfficeLinkOptions, id: string, eventId: string): Promise<LinkResponse> {
  const found = await opts.store.getTrace(eventId);
  return found
    ? { id, result: { trace: present(found.data as Trace, opts.links) } }
    : error(id, "not_found", `No trace for event ${eventId}.`);
}

const items = async (
  opts: OfficeLinkOptions,
  id: string,
  params: Params<"items">,
): Promise<LinkResponse> => ({
  id,
  result: await findItems(opts.store, params ?? {}),
});

const activity = async (
  opts: OfficeLinkOptions,
  id: string,
  params: Params<"activity">,
): Promise<LinkResponse> => ({
  id,
  result: await countActivity(opts.store, opts.clock.now(), params?.windows),
});

async function item(opts: OfficeLinkOptions, id: string, itemId: string): Promise<LinkResponse> {
  const found = await findItem(opts.store, itemId);
  return found
    ? { id, result: { item: found.item, traces: found.traces.map((t) => present(t, opts.links)) } }
    : error(id, "not_found", `No work item ${itemId}.`);
}

async function health(opts: OfficeLinkOptions, id: string, run: boolean): Promise<LinkResponse> {
  if (run) {
    await opts.doctor.run();
  }

  return { id, result: await opts.doctor.health() };
}

type Handler<M extends LinkMethod> = (
  opts: OfficeLinkOptions,
  r: Extract<LinkRequest, { method: M }>,
) => Promise<LinkResponse>;

/** How each method is answered. */
const HANDLERS: { [M in LinkMethod]: Handler<M> } = {
  people: (opts, r) => people(opts, r.id),
  events: (opts, r) => events(opts, r.id, r.params),
  event: (opts, r) => event(opts, r.id, r.params.id),
  items: (opts, r) => items(opts, r.id, r.params),
  activity: (opts, r) => activity(opts, r.id, r.params),
  item: (opts, r) => item(opts, r.id, r.params.id),
  health: (opts, r) => health(opts, r.id, r.params?.run === true),
};

// A method is matched to its own request by the table, which the compiler cannot follow through the lookup.
const dispatch = (opts: OfficeLinkOptions, r: LinkRequest) =>
  (HANDLERS[r.method] as Handler<LinkMethod>)(opts, r as never);

/** Answers one request of the service. Never throws: a failure is an error response. */
export async function answer(opts: OfficeLinkOptions, r: LinkRequest): Promise<LinkResponse> {
  try {
    return await dispatch(opts, r);
  } catch (e) {
    opts.logger.warn("office link: a request failed", { method: r.method, error: String(e) });
    return error(r.id, "failed", "The office could not answer.");
  }
}
