import type { Intake } from "./intake/index.js";
import type { Store } from "./store/types.js";
import type { Clock } from "./types.js";

export interface ChatEntryOptions {
  intake: Pick<Intake, "receive">;
  store: Pick<Store, "getSubject" | "upsertSubject">;
  clock: Clock;
}
