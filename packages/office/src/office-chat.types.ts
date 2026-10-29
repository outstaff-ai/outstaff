import type { Logger } from "@outstaff/core";
import type { Intake } from "./intake/index.js";
import type { OfficePipeline } from "./pipeline/office-pipeline.types.js";
import type { ChatDesk } from "./protocol/source.types.js";
import type { Store } from "./store/types.js";
import type { Clock } from "./types.js";

export interface ChatEntryOptions {
  mode: OfficePipeline["mode"];

  /** The chat desk, which routes messages itself while the pipeline is off or in shadow mode. */
  desk: Pick<ChatDesk, "message">;
  intake: Pick<Intake, "receive">;
  store: Pick<Store, "getSubject" | "upsertSubject">;
  clock: Clock;
  logger: Logger;
}
