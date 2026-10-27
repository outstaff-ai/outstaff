import type { LinkMessageMeta, LinkMessageType, LinkMethod } from "./types.js";

export const LINK_MESSAGE_META: Record<LinkMessageType, LinkMessageMeta> = {
  welcome: {
    from: "service",
    summary:
      "First message after the service accepts the connection: which office this is. The office answers requests and sends notifications only after it.",
  },
  hello: {
    from: "office",
    summary: "Sent right after the `welcome`: the office's team, version and pipeline mode.",
  },
  request: {
    from: "service",
    summary:
      "Asks the office for data; see Methods. Answered by one `response` with the same `id`.",
  },
  response: {
    from: "office",
    summary: "The answer to a `request`: its `result`, or an `error`.",
  },
  people: {
    from: "office",
    summary:
      "Every person with the item it works on and its queue, as the `people` method gives it. Sent when the welcome comes and whenever it changes, at most about once a second.",
  },
  trace: {
    from: "office",
    summary: "An event the pipeline judged, as soon as the office records its trace.",
  },
  item: {
    from: "office",
    summary:
      "A work item was queued or its status changed, with what a list of items shows (title, subject, kind, person, status), so a service can patch its list without asking.",
  },
  health: {
    from: "office",
    summary:
      "The doctor checks, as the `health` method gives them. Sent when the welcome comes and whenever a check is added, removed or changes, not when a run only confirms them.",
  },
  ping: { from: "both", summary: "Checks that the other side is there; answer with `pong`." },
  pong: { from: "both", summary: "Answers `ping`." },
};

export const LINK_METHOD_META: Record<LinkMethod, string> = {
  people:
    "The people snapshot: each person, connected or not, with the item it works on and its queue in run order, each with why it is queued.",
  events:
    "Traces of the events the pipeline judged, newest first, filtered on the office, with the `total` that match. Page with `before` = `nextBefore`.",
  event: "One event's trace, by event id. `not_found` when the office has none.",
  items:
    "Work items, newest first by when they were created, optionally of one status or person, with the `total` that match. Page with `before` = `nextBefore`.",
  compare:
    "How the engine and the pipeline compare over the events in a range, as `ost explain --compare` sums it up: totals, differences by kind and by policy, and the events that differ. Only events traced in shadow mode are compared.",
  item: "One work item with its runs, the end of its journal and the traces of the events that queued or joined it. `not_found` when there is no such item.",
  activity:
    "How much happened in each of the last few windows of time (default the last hour and the last day): events that happened and work items created. Exact, since the office counts them in its store.",
  health:
    "The doctor checks: the ones the office runs at start, every day at `office.doctor.daily_at` and on demand, and the ones each agent reports when it starts. A failing check stays failing until a later run passes.",
};
