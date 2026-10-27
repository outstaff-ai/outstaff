import type { Store, NewConversation } from "../types.js";
import { iso, newId } from "./ids.js";
import { toConversation } from "./rows.js";
import type { StoreInternals } from "./types.js";

/** The store's queries on conversations between agents. */
export function conversationQueries({
  db,
  now,
}: StoreInternals): Pick<
  Store,
  | "createConversation"
  | "answerConversation"
  | "getConversation"
  | "listUndelivered"
  | "markDelivered"
> {
  const stamp = () => iso(now());

  return {
    async createConversation(input: NewConversation) {
      const at = now();
      const row = await db
        .insertInto("conversations")
        .values({
          id: newId(at.getTime()),
          asker_item_id: input.askerItemId,
          target: input.target,
          question: input.question,
          answer: null,
          status: "open",
          depth: input.depth ?? 0,
          created_at: iso(at),
          answered_at: null,
          delivered_at: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return toConversation(row);
    },

    async answerConversation(id, answer) {
      const row = await db
        .updateTable("conversations")
        .set({ answer, status: "answered", answered_at: stamp() })
        .where("id", "=", id)
        .where("status", "=", "open")
        .returningAll()
        .executeTakeFirst();

      if (!row) {
        throw new Error(`conversation ${id} is unknown or already answered`);
      }

      return toConversation(row);
    },

    async getConversation(id) {
      const row = await db
        .selectFrom("conversations")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();

      return row ? toConversation(row) : undefined;
    },

    async listUndelivered(askerItemId) {
      const rows = await db
        .selectFrom("conversations")
        .selectAll()
        .where("asker_item_id", "=", askerItemId)
        .where("status", "=", "answered")
        .where("delivered_at", "is", null)
        .orderBy("answered_at", "asc")
        .orderBy("id", "asc")
        .execute();

      return rows.map(toConversation);
    },

    async markDelivered(id) {
      await db
        .updateTable("conversations")
        .set({ delivered_at: stamp() })
        .where("id", "=", id)
        .where("delivered_at", "is", null)
        .execute();
    },
  };
}
