import type { PrRef } from "@outstaff/core";

/** An event the office judged, as far as a silent hand-back's hold needs it. */
export interface HeardEvent {
  type: string;
  at: string;
  actor: { kind: string; id: string };
  subject: { ticket?: string | undefined; pr?: PrRef | undefined };
  data: Record<string, unknown>;
}
