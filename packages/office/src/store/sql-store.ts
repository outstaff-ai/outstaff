import type { Store } from "./types.js";
import { doctorQueries } from "./sql/doctor.js";
import { conversationQueries } from "./sql/conversations.js";
import { eventQueries } from "./sql/events.js";
import { guardQueries } from "./sql/guards.js";
import { itemQueries } from "./sql/items.js";
import { linkQueries } from "./sql/links.js";
import { refQueries } from "./sql/refs.js";
import { runQueries } from "./sql/runs.js";
import { traceQueries } from "./sql/traces.js";
import type { StoreInternals } from "./sql/types.js";

export function createSqlStore(internals: StoreInternals): Store {
  const { db, dialect } = internals;
  const store: Store = {
    dialect,
    ...eventQueries(internals),
    ...itemQueries(internals),
    ...runQueries(internals),
    ...linkQueries(internals),
    ...refQueries(internals),
    ...guardQueries(internals),
    ...conversationQueries(internals),
    ...traceQueries(internals),
    ...doctorQueries(internals),

    async close() {
      await db.destroy();
    },
  };

  return store;
}
