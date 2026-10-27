// What both Its a Plan adapters (tracker and knowledge) share. Neither adapter depends on the other.
export { Itsaplan, createClient } from "./client.js";
export { ItsaplanHttp, errorCode } from "./http.js";
export { Pacer, pacerFor } from "./pacing.js";
export { buildFetch } from "./fetch.js";
export {
  connectionOptions,
  deriveApiUrl,
  optionalConnectionOptions,
  resolveConnection,
} from "./options.js";

export { nextCursor, OVERLAP_MS, parseCursor } from "./cursor.js";
export { doctorItsaplan } from "./doctor.js";
export { deriveItsaplan, itsaplanSetupGuide } from "./setup.js";
export { itsaplanSecrets } from "./secrets.js";
export type {
  ClientDeps,
  Clock,
  Connection,
  ConnectionOptions,
  EventCursor,
  HttpConfig,
  OptionalConnectionOptions,
  RequestOptions,
} from "./types.js";

// The REST shapes the adapters read; the Its a Plan stand-in (@outstaff/testing.itsaplan) derives its own from them.
export type * from "./api.types.js";
