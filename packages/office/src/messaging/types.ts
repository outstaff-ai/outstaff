import type { Chat, Logger, TeamConfig, Tracker } from "@outstaff/core";
import type { Human, Member, MemberUsage } from "@outstaff/protocol";
import type { Scheduler } from "../scheduler/types.js";
import type { Store } from "../store/types.js";

export interface MessagingOptions {
  store: Store;
  scheduler: Pick<Scheduler, "enqueue">;
  team: Pick<TeamConfig, "people" | "humans" | "office">;
  logger?: Logger;
  chat?: Chat;
  tracker?: Tracker;

  /** Channel for mirroring; defaults to `office.channel` of team.yaml. */
  channel?: string;
  roles?: RosterOptions["roles"];
  humans?: RosterOptions["humans"];
  usage?: RosterOptions["usage"];

  /** Questions asked while answering questions, at most this deep. Default 3. */
  maxDepth?: number;

  /** Called after work was queued for a person, so the protocol server can offer it at once. */
  notify?: (person: string) => void;
}

export interface MirrorOptions {
  chat?: Chat | undefined;
  channel?: string | undefined;
  tracker?: Tracker | undefined;
  logger?: Logger | undefined;
}

export type MirrorWhere = "channel" | "ticket" | "journal";

export interface RoleInfo {
  title: string;
  summary: string;
}

export interface RosterOptions {
  store: Pick<Store, "listItems" | "listPauses">;
  team: Pick<TeamConfig, "people" | "humans">;

  /** Titles and summaries of the roles, from the catalog when the office has it. Without an entry the role id is shown. */
  roles?: ReadonlyMap<string, RoleInfo> | Record<string, RoleInfo>;

  /** Trusted humans when team.yaml lists none (then they come from repo writers and chat members). */
  humans?: () => Promise<Human[]>;

  /** The person's busiest recent usage window, when known. */
  usage?: (person: string) => Promise<MemberUsage | undefined>;
}

export interface Roster {
  members: Member[];
  humans: Human[];
}

/** Why a question could not be routed; `message` is shown to the asker as is. */
export type Route =
  | { ok: true; handle: string }
  | { ok: false; code: "invalid" | "not_found"; message: string };

export interface RoutablePerson {
  handle: string;
  role: string;
}
