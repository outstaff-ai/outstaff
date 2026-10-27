import type { LinkErrorCode, LinkRequest, LinkResponse } from "@outstaff/protocol";
import type { Trace } from "../pipeline/trace.types.js";
import { findEvents } from "./events.js";
import { findItem } from "./item.js";
import { findItems } from "./items.js";
import type { OfficeLinkOptions } from "./link.types.js";
import { listPeople } from "./people.js";
import { present } from "./present.js";

const error = (id: string, code: LinkErrorCode, message: string): LinkResponse => ({
  id,
  error: { code, message },
});

async function events(
  opts: OfficeLinkOptions,
  id: string,
  params: Parameters<typeof findEvents>[1],
) {
  const found = await findEvents(opts.store, params);
  const result = { ...found, events: found.events.map((t) => present(t, opts.links)) };
  return { id, result } satisfies LinkResponse;
}

async function event(opts: OfficeLinkOptions, id: string, eventId: string): Promise<LinkResponse> {
  const found = await opts.store.getTrace(eventId);
  return found
    ? { id, result: { trace: present(found.data as Trace, opts.links) } }
    : error(id, "not_found", `No trace for event ${eventId}.`);
}

async function item(opts: OfficeLinkOptions, id: string, itemId: string): Promise<LinkResponse> {
  const found = await findItem(opts.store, itemId);
  return found
    ? { id, result: { item: found.item, traces: found.traces.map((t) => present(t, opts.links)) } }
    : error(id, "not_found", `No work item ${itemId}.`);
}

async function dispatch(opts: OfficeLinkOptions, r: LinkRequest): Promise<LinkResponse> {
  switch (r.method) {
    case "people":
      return {
        id: r.id,
        result: { at: opts.clock.now().toISOString(), people: await listPeople(opts) },
      };
    case "events":
      return events(opts, r.id, r.params ?? {});
    case "event":
      return event(opts, r.id, r.params.id);
    case "items":
      return { id: r.id, result: await findItems(opts.store, r.params ?? {}) };
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
