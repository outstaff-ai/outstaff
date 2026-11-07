import type { ChatCursorStore } from "#/store/chat-cursors.types.js";
import { iso } from "./ids.js";
import type { StoreInternals } from "./types.js";

/** The top level of a conversation is stored as an empty thread, so the key has no null in it. */
const TOP = "";

/** The store's queries on the chat cursors, on either dialect. */
export function chatCursorQueries({ db, now }: StoreInternals): ChatCursorStore {
  return {
    async advanceChatCursor(person, { channel, thread, at }) {
      const updatedAt = iso(now());
      await db
        .insertInto("chat_cursors")
        .values({ person, channel, thread: thread ?? TOP, at, updated_at: updatedAt })
        .onConflict((oc) =>
          oc
            .columns(["person", "channel", "thread"])
            .doUpdateSet({ at, updated_at: updatedAt })
            .where("chat_cursors.at", "<", at),
        )
        .execute();
    },

    async listChatCursors(person, limit) {
      const rows = await db
        .selectFrom("chat_cursors")
        .select(["channel", "thread", "at"])
        .where("person", "=", person)
        .orderBy("at", "desc")
        .limit(limit)
        .execute();

      return rows.map((r) => ({
        channel: r.channel,
        ...(r.thread === TOP ? {} : { thread: r.thread }),
        at: r.at,
      }));
    },
  };
}
