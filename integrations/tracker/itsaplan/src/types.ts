import type { z } from "zod";
import type { Logger } from "@outstaff/core";
import type { knowledgeOptions, trackerOptions } from "./options.js";
import type { Pacer } from "./pacing.js";

export type TrackerOptions = z.output<typeof trackerOptions>;
export type KnowledgeOptions = z.output<typeof knowledgeOptions>;

export interface Connection extends TrackerOptions {
  api_url: string;
}

export interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface EventCursor {
  since: number;
  seen: Set<string>;
}

export interface HttpConfig {
  fetch: typeof fetch;
  apiUrl: string;

  /** Sent as `Origin`, which the API checks on writes. */
  webUrl: string;
  apiKey: string;
  log?: Logger;

  /** Paces this key's requests; by default one shared by every client of the same key and host. */
  pacer?: Pacer;

  /** Used for the wait before a retry; tests inject their own. */
  clock?: Clock;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;

  /** A multipart body, for a file upload. Sent instead of `body`; fetch sets the content type and boundary. */
  form?: FormData;
}

export interface ClientDeps {
  readFile?: (path: string) => string;

  /** Builds a fetch that trusts the given PEM text; the default uses an undici Agent. */
  tlsFetch?: (ca: string) => Promise<typeof fetch>;
}

export type {
  ApiActivityItem,
  ApiAssignee,
  ApiAttachment,
  ApiColumn,
  ApiFeedItem,
  ApiIssue,
  ApiLabel,
  ApiProject,
  Page,
} from "./api.types.js";
