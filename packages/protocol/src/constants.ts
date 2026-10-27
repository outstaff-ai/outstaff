/** Bumped on any incompatible change to the messages below. Both sides must match exactly. */
export const PROTOCOL_VERSION = 1;

export const WORK_STATUSES = [
  "queued",
  "active",
  "waiting",
  "done",
  "blocked",
  "canceled",
] as const;

export const MEMBER_STATUSES = ["idle", "working", "paused", "offline"] as const;

export const ERROR_CODES = [
  "malformed",
  "unknown_type",
  "invalid_message",
  "unauthenticated",
  "auth_failed",
  "version_mismatch",
  "replaced",
  "unknown_item",
  "not_found",
  "invalid",
  "unsupported",
  "failed",
] as const;

/** Most files of one message the office keeps and the agent considers. */
export const MAX_CHAT_FILES = 10;
