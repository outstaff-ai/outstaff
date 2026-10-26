import type { SlackMessage, SlackPage } from "./api.js";
import { callSlack } from "./errors.js";

/** Read pages until `limit` messages are in hand, oldest first. */
export async function readPages(
  fetchPage: (cursor?: string) => Promise<SlackPage>,
  limit: number,
  newestFirst: boolean,
): Promise<SlackMessage[]> {
  const out: SlackMessage[] = [];
  let cursor: string | undefined;
  do {
    const page = await callSlack(() => fetchPage(cursor));
    out.push(...(page.messages ?? []));
    cursor = page.response_metadata?.next_cursor || undefined;
    // History pages run newest first, so enough of them is enough; thread pages run oldest first and need all.
  } while (cursor && (!newestFirst || out.length < limit));

  return newestFirst ? out.slice(0, limit).toReversed() : out.slice(-limit);
}
