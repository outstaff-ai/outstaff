import { PortError, type PortErrorCode } from "@outstaff/core";

const BY_SLACK_ERROR: Record<string, PortErrorCode> = {
  message_not_found: "not_found",
  channel_not_found: "not_found",
  thread_not_found: "not_found",
  user_not_found: "not_found",
  users_not_found: "not_found",
  bad_timestamp: "not_found",
  not_in_channel: "forbidden",
  is_archived: "forbidden",
  missing_scope: "forbidden",
  not_authed: "forbidden",
  invalid_auth: "forbidden",
  account_inactive: "forbidden",
  token_revoked: "forbidden",
  restricted_action: "forbidden",
  cannot_dm_bot: "forbidden",
  ratelimited: "rate_limited",
  invalid_arguments: "invalid",
  invalid_blocks: "invalid",
  msg_too_long: "invalid",
  no_text: "invalid",
};

/** Slack's SDK errors carry the API's error string in `data.error` and a `retryAfter` (seconds) on rate limits. */
export function toPortError(error: unknown): PortError {
  if (error instanceof PortError) {
    return error;
  }

  const e = error as { code?: string; data?: { error?: string }; retryAfter?: number } | undefined;
  const slack = e?.data?.error;
  const message = error instanceof Error ? error.message : String(error);
  if (e?.code === "slack_webapi_rate_limited_error") {
    return new PortError("rate_limited", message, {
      cause: error,
      ...(e.retryAfter === undefined ? {} : { retryAfterMs: e.retryAfter * 1000 }),
    });
  }

  return new PortError((slack && BY_SLACK_ERROR[slack]) || "unavailable", message, {
    cause: error,
  });
}

export function slackErrorName(error: unknown): string | undefined {
  return (error as { data?: { error?: string } } | undefined)?.data?.error;
}
