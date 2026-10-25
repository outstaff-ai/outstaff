import type { Vcs } from "@outstaff/core";
import type { ConversationEntry, Feedback } from "@outstaff/protocol";
import type { Store, WorkItem } from "./store/types.js";
import type { PrRecord } from "./workstate/index.js";

/** How many earlier entries a round starts with: enough for a short reply to have its context. */
export const CONTEXT_ENTRIES = 5;
const MAX_BODY = 600;
// Entries after the first trigger are not context, so the fetch must reach past them.
const FETCH = 100;

const trimmed = (body: string) =>
  body.length > MAX_BODY
    ? `${body.slice(0, MAX_BODY).trimEnd()} ... (trimmed; \`ost pr conversation\` shows all of it)`
    : body;

/**
 * The conversation entries just before the first comment or review summary that started the round, oldest first.
 * Read with the office's read-only App, so the prompt carries them without a call from the agent. Best effort: the
 * round must start even when the host cannot be read, and then the agent reads the conversation itself.
 */
export async function previousConversation(
  store: Pick<Store, "getSubject">,
  vcs: Pick<Vcs, "conversation"> | undefined,
  item: Pick<WorkItem, "subject">,
  feedback: Feedback[],
): Promise<ConversationEntry[]> {
  if (!vcs || item.subject?.type !== "pr") {
    return [];
  }

  const started = feedback.filter((f) => f.kind === "comment" || f.kind === "review");
  const triggers = started.map((f) => Date.parse(f.at ?? "")).filter((t) => !Number.isNaN(t));

  if (triggers.length === 0) {
    return [];
  }

  const first = Math.min(...triggers);

  // The host reports an event slightly after the entry it is about, so the trigger itself is also dropped by link.
  const own = new Set(started.flatMap((f) => (f.url ? [f.url] : [])));
  const rec = (await store.getSubject("pr", item.subject.ref))?.data as PrRecord | undefined;
  if (!rec) {
    return [];
  }

  try {
    const entries = await vcs.conversation(rec.ref.repo, rec.ref.number, { limit: FETCH });
    return entries
      .filter((e) => Date.parse(e.at) < first && !own.has(e.url))
      .slice(-CONTEXT_ENTRIES)
      .map((e) => ({
        kind: e.kind,
        author: e.author,
        at: e.at,
        ...(e.state ? { state: e.state } : {}),
        ...(e.url ? { url: e.url } : {}),
        body: trimmed(e.body.trim()),
      }));
  } catch {
    return [];
  }
}
