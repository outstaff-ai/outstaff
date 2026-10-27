import type { LinkErrorCode, LinkRequest, LinkResponse } from "@outstaff/protocol";
import type { Trace } from "../pipeline/trace.types.js";
import { compareRange } from "../pipeline/compare/summary.js";
import { findEvents } from "./events.js";
import { findItem } from "./item.js";
import { findItems } from "./items.js";
import type { OfficeLinkOptions } from "./link.types.js";
import { listPeople } from "./people.js";
import { present } from "./present.js";

/** The office store's traces, as the comparison reads them. */
const storeTraces = (store: OfficeLinkOptions["store"]) => ({
  list: async (q?: { before?: string; limit?: number }) =>
    (await store.listTraces(q)).map((r) => r.data as Trace),
});

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
  const found = await findEvents(opts.store, params ?? {});
  return { id, result: { ...found, events: found.events.map((t) => present(t, opts.links)) } };
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

const compare = async (
  opts: OfficeLinkOptions,
  id: string,
  params: Params<"compare">,
): Promise<LinkResponse> => ({
  id,
  result: await compareRange(storeTraces(opts.store), params ?? {}),
});

async function item(opts: OfficeLinkOptions, id: string, itemId: string): Promise<LinkResponse> {
  const found = await findItem(opts.store, itemId);
  return found
    ? { id, result: { item: found.item, traces: found.traces.map((t) => present(t, opts.links)) } }
    : error(id, "not_found", `No work item ${itemId}.`);
}

function dispatch(opts: OfficeLinkOptions, r: LinkRequest): Promise<LinkResponse> {
  switch (r.method) {
    case "people":
      return people(opts, r.id);
    case "events":
      return events(opts, r.id, r.params);
    case "event":
      return event(opts, r.id, r.params.id);
    case "items":
      return items(opts, r.id, r.params);
    case "compare":
      return compare(opts, r.id, r.params);
    case "item":
      return item(opts, r.id, r.params.id);
  }
}

/** Answers one request of the service. Never throws: a failure is an error response. */
export async function answer(opts: OfficeLinkOptions, r: LinkRequest): Promise<LinkResponse> {
  try {
    return await dispatch(opts, r);
  } catch (e) {
    opts.logger.warn("office link: a request failed", { method: r.method, error: String(e) });
    return error(r.id, "failed", "The office could not answer.");
  }
}
