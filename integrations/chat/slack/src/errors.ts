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

type SlackSdkError = { code?: string; data?: { error?: string }; retryAfter?: number } | undefined;

function isRateLimited(e: SlackSdkError): boolean {
  return e?.code === "slack_webapi_rate_limited_error";
}

function retryAfterOf(e: SlackSdkError): { retryAfterMs?: number } {
  return e?.retryAfter === undefined ? {} : { retryAfterMs: e.retryAfter * 1000 };
}

function codeOf(e: SlackSdkError): PortErrorCode {
  const slack = e?.data?.error;
  return (slack && BY_SLACK_ERROR[slack]) || "unavailable";
}

/** Slack's SDK errors carry the API's error string in `data.error` and a `retryAfter` (seconds) on rate limits. */
export function toPortError(error: unknown): PortError {
  if (error instanceof PortError) {
    return error;
  }

  const e = error as SlackSdkError;
  const message = error instanceof Error ? error.message : String(error);
  if (isRateLimited(e)) {
    return new PortError("rate_limited", message, { cause: error, ...retryAfterOf(e) });
  }

  return new PortError(codeOf(e), message, { cause: error });
}

export function slackErrorName(error: unknown): string | undefined {
  return (error as { data?: { error?: string } } | undefined)?.data?.error;
}

/** Run a Slack call, turning what it throws into a PortError. */
export async function callSlack<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toPortError(error);
  }
}
