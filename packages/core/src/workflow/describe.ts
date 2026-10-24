import type { Effect } from "./types.js";

/** One line saying what an effect does; shared by `ost workflow explain` and the office's logs. */
export function describeEffect(e: Effect): string {
  switch (e.type) {
    case "move":
      return `move ${e.ticket} to ${e.to}`;
    case "assign":
      return `assign ${e.ticket} to ${e.to ? `${e.to.kind} ${e.to.id}` : "nobody"}`;
    case "comment":
      return `comment "${e.template}" on ${"ticket" in e.on ? e.on.ticket : `pull request #${e.on.pr.number}`}`;
    case "schedule":
      return `schedule ${e.kind} for ${e.person} (${e.priority})`;
    case "notify":
      return `notify ${e.to.kind}${e.to.id ? ` ${e.to.id}` : ""} with "${e.template}"`;
  }
}
