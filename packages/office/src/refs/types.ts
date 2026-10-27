import type { PrRef } from "@outstaff/core";

/** What an event is about, as the engine and the event pipeline both describe it. */
export interface EventSubject {
  ticket?: string | undefined;
  pr?: PrRef | undefined;
  doc?: string | undefined;
  chat?: { channel: string; thread?: string | undefined } | undefined;
}
