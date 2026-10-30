import type { PrRef } from "@outstaff/core";

/** What an event is about, as the event pipeline describes it. */
export interface EventSubject {
  ticket?: string | undefined;
  pr?: PrRef | undefined;
  doc?: string | undefined;
  chat?: { channel: string; thread?: string | undefined } | undefined;
}
