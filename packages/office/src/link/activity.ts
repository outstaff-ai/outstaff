import type { LinkResultOf } from "@outstaff/protocol";
import type { LinkStore } from "./link.types.js";

/** The windows `activity` counts when the request names none: the last hour and the last day. */
export const DEFAULT_WINDOWS = [3600, 86400];

/** Events that happened and work items created in each window, counted back from `now`. */
export async function countActivity(
  store: Pick<LinkStore, "countTraces" | "listItems">,
  now: Date,
  windows: number[] = DEFAULT_WINDOWS,
): Promise<LinkResultOf<"activity">> {
  const items = await store.listItems();
  return {
    at: now.toISOString(),
    windows: await Promise.all(
      windows.map(async (seconds) => {
        const since = new Date(now.getTime() - seconds * 1000).toISOString();
        return {
          seconds,
          since,
          events: await store.countTraces({ since }),
          items: items.filter((i) => i.createdAt > since).length,
        };
      }),
    ),
  };
}
