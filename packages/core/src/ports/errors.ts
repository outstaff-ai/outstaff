export const PORT_ERROR_CODES = [
  "not_found",
  "forbidden",
  "conflict",
  "rate_limited",
  "unavailable",
  "invalid",
  "unsupported",
] as const;

export type PortErrorCode = (typeof PORT_ERROR_CODES)[number];

/** Adapters map platform errors to this; callers never see platform types. */
export class PortError extends Error {
  readonly code: PortErrorCode;
  readonly retryAfterMs: number | undefined;

  constructor(
    code: PortErrorCode,
    message: string,
    opts: { retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "PortError";
    this.code = code;
    this.retryAfterMs = opts.retryAfterMs;
  }
}
