import type { Chat, Logger, TeamConfig } from "@outstaff/core";
import type { Human, Member, MemberUsage } from "@outstaff/protocol";
import type { Scheduler } from "#/scheduler/types.js";
import type { Store } from "#/store/types.js";
import type { ActDesk } from "#/pipeline/act/act.types.js";

export interface MessagingOptions {
  store: Store;
  scheduler: Pick<Scheduler, "enqueue">;
  team: Pick<TeamConfig, "people" | "humans" | "office">;
  logger?: Logger;
  chat?: Chat;

  /** Where a mirror to the ticket goes: a comment the asker's agent posts as itself. */
  acts?: Pick<ActDesk, "send">;

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
  acts?: Pick<ActDesk, "send"> | undefined;
  logger?: Logger | undefined;
}

/** What is mirrored, and the id of the act that posts it on a ticket, so it is posted once. */
export interface Mirrored {
  id: string;
  text: string;
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
