import type { z } from "zod";
import type { comparisonSummarySchema } from "./comparison.js";
import type {
  itemSchema,
  itemSummarySchema,
  personSchema,
  scheduledBySchema,
  traceSchema,
} from "./entities.js";
import type {
  LINK_ERROR_CODES,
  linkMessageSchema,
  requestSchema,
  RESULT_SCHEMAS,
  responseSchema,
} from "./schemas.js";

export type LinkMessage = z.infer<typeof linkMessageSchema>;
export type LinkMessageType = LinkMessage["type"];
export type LinkPayloadOf<T extends LinkMessageType> = Extract<LinkMessage, { type: T }>["payload"];
export type LinkRequest = z.infer<typeof requestSchema>;
export type LinkMethod = LinkRequest["method"];
export type LinkResponse = z.infer<typeof responseSchema>;
export type LinkResultOf<M extends LinkMethod> = z.infer<(typeof RESULT_SCHEMAS)[M]>;
export type LinkErrorCode = (typeof LINK_ERROR_CODES)[number];
export type LinkPerson = z.infer<typeof personSchema>;
export type LinkTrace = z.infer<typeof traceSchema>;
export type LinkItem = z.infer<typeof itemSchema>;
export type ScheduledBy = z.infer<typeof scheduledBySchema>;
export type LinkItemSummary = z.infer<typeof itemSummarySchema>;
export type LinkSource = LinkTrace["event"]["source"];

export interface LinkMessageMeta {
  from: "office" | "service" | "both";
  summary: string;
}

export type LinkComparisonSummary = z.infer<typeof comparisonSummarySchema>;
