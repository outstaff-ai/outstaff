import type {
  AgentProfile,
  Chat,
  Logger,
  Runtime,
  TeamConfig,
  Tracker,
  UsageEvent,
} from "@outstaff/core";
import type { ClientClock, Offer } from "../office-client/index.js";
import type { OfficeClient } from "../verbs/office.types.js";

/** A file a person shared in chat: where it is on disk, or why it is not. All of it is data from that person. */
export interface Attachment {
  name: string;
  mimetype: string;
  size: number;

  /** The downloaded copy, in the item's scratch directory. Absent when the file was not downloaded. */
  path?: string;

  /** Why there is no copy. */
  skipped?: string;
}

/** What is known of a file before it is downloaded. */
export interface RemoteFile {
  name: string;
  mimetype: string;
  size: number;
}

export interface SaveOptions<F extends RemoteFile> {
  /** Fetches the bytes; absent when the source cannot serve files. */
  download: ((file: F) => Promise<Uint8Array>) | undefined;
  dir: string;
  log?: Logger;
}

export interface IdentityRole {
  title: string;
  summary?: string;
}

export interface IdentityInput {
  team: TeamConfig;
  handle: string;
  role?: IdentityRole;
}

/** What the profile publisher uses of the office connection. */
export type ProfileOffice = Pick<OfficeClient, "work">;

export interface ProfilePublisherOptions {
  chat: Required<Pick<Chat, "setAgentProfile">> & Pick<Chat, "onProfileRequest">;
  office: ProfileOffice;
  team: TeamConfig;

  /** Who the agent is, for the top of the profile. */
  who: { name: string; role: string; description?: string; model?: string };
  tracker?: Pick<Tracker, "links">;
  log?: Logger;
  now?: () => number;

  /** Quiet time after a change before the profile is published, so a burst of changes publishes once. Default 2000. */
  debounceMs?: number;

  /** Longest time between two publications while working. Default 300000 (5 minutes). */
  refreshEveryMs?: number;
}

export interface ProfilePublisher {
  /** Publishes the profile for each trusted human now, and keeps it up to date until `stop`. */
  start(): Promise<void>;

  /** The work or the status changed: publishes once the changes have settled. */
  changed(): void;
  stop(): void;

  /** The profile as it is now. */
  build(): Promise<AgentProfile>;
}

/** Where the office keeps the session of an item. */
export interface SessionStore {
  session(workItemId: string, sessionId: string): Promise<void>;
}

/**
 * One runtime session per work item (decision 0010): a later round resumes the session stored with the item, and a
 * session is never used for another item. The office persists the id, so it survives restarts of the agent.
 *
 * Chat sessions have a second kind of key, the thread. The chat sessions of one thread (the first, and a follow-up
 * after it was done) share one session, and a thread session is never used for an item that did not come
 * from that thread, nor an item session for a thread. The office stores both with the item and carries the id over
 * to the next item of the thread.
 */
export interface SessionManager {
  /** The session to resume for the offered item, if an earlier round started one. */
  resumeFor(offer: Offer): string | undefined;

  /** Stores the session the runtime started (or kept) for the item, once. */
  started(workItemId: string, sessionId: string): Promise<void>;
}

export interface UsageThresholds {
  defer_scheduled_at: number;
  pause_automatic_at: number;
}

export interface UsageReporterOptions {
  /** Sends the windows to the office. */
  send(windows: UsageEvent["windows"]): Promise<void>;

  /** The runtime to probe while idle; without `probeUsage` only runtime events are forwarded. */
  runtime?: Pick<Runtime, "probeUsage">;

  /** The team's usage thresholds: crossing one is reported at once. */
  thresholds?: UsageThresholds;

  /** Least time between two reports that do not cross a threshold. Default 60000. */
  minIntervalMs?: number;

  /** Time between idle probes. Default 600000. */
  probeEveryMs?: number;
  clock?: ClientClock;
  log?: Logger;
}

export interface UsageReporter {
  /** A usage event from a running item: sent now, or held until the next send or `flush`. */
  observe(event: UsageEvent): void;

  /** Sends the newest held report, if any. */
  flush(): void;

  /** The loop tells whether an item is running; probes only happen while idle. */
  setBusy(busy: boolean): void;

  /** Probes now and then every `probeEveryMs` while idle. */
  start(): void;
  stop(): void;
}
