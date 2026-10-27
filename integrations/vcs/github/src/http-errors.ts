import { PortError, type PortErrorCode } from "@outstaff/core";

export const DEFAULT_SECONDARY_LIMIT_MS = 60_000;

// Statuses that name their own error; any other is unavailable from 500 up and invalid below.
const STATUS_CODES = new Map<number, PortErrorCode>([
  [400, "invalid"],
  [401, "forbidden"],
  [403, "forbidden"],
  [404, "not_found"],
  [409, "conflict"],
  [422, "invalid"],
]);

const GRAPHQL_CODES = new Map<string | undefined, PortErrorCode>([
  ["NOT_FOUND", "not_found"],
  ["FORBIDDEN", "forbidden"],
  ["INSUFFICIENT_SCOPES", "forbidden"],
  ["RATE_LIMITED", "rate_limited"],
]);

/** The JSON body of a response, or undefined when it is empty or not JSON. */
export function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

/** A 429, or a 403 that GitHub sends for its secondary rate limits. */
function isRateLimited(res: Response, message: string): boolean {
  if (res.status !== 403) {
    return res.status === 429;
  }

  return (
    res.headers.get("retry-after") !== null ||
    res.headers.get("x-ratelimit-remaining") === "0" ||
    /rate limit/i.test(message)
  );
}

/** A header as a finite number, or undefined when it is missing or not a number. */
function numberHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  const value = Number(raw);
  return raw !== null && Number.isFinite(value) ? value : undefined;
}

/** How long a rate limit says to wait: `retry-after`, else until `x-ratelimit-reset`, else a minute. */
export function retryAfterMs(headers: Headers, now: () => Date): number {
  const retryAfter = numberHeader(headers, "retry-after");
  if (retryAfter !== undefined) {
    return Math.max(0, retryAfter * 1000);
  }

  const reset = numberHeader(headers, "x-ratelimit-reset");
  if (reset !== undefined) {
    return Math.max(0, reset * 1000 - now().getTime());
  }

  return DEFAULT_SECONDARY_LIMIT_MS;
}

/** The PortError for a failed REST response. */
export function toHttpError(
  request: { method: string; url: string; now: () => Date },
  res: Response,
  data: unknown,
  text: string,
): PortError {
  const message =
    (data as { message?: string } | undefined)?.message ?? (text.slice(0, 200) || res.statusText);

  const what = `${request.method} ${new URL(request.url).pathname}: ${res.status} ${message}`;
  if (isRateLimited(res, message)) {
    return new PortError("rate_limited", `GitHub rate limit: ${what}`, {
      retryAfterMs: retryAfterMs(res.headers, request.now),
    });
  }

  const code = STATUS_CODES.get(res.status) ?? (res.status >= 500 ? "unavailable" : "invalid");
  return new PortError(code, code === "forbidden" ? `GitHub refused: ${what}` : `GitHub: ${what}`);
}

/** The PortError for the first error of a GraphQL answer. */
export function graphqlError(first: { type?: string; message: string }): PortError {
  const code = GRAPHQL_CODES.get(first.type) ?? "invalid";
  return new PortError(
    code,
    `GitHub GraphQL: ${first.message}`,
    code === "rate_limited" ? { retryAfterMs: DEFAULT_SECONDARY_LIMIT_MS } : {},
  );
}

/** Fetches, turning a network failure into an unavailable PortError that names the host as `who`. */
export async function reach(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  who: string,
): Promise<Response> {
  try {
    return await fetcher(url, init);
  } catch (cause) {
    throw new PortError("unavailable", `${who} is unreachable: ${(cause as Error).message}`, {
      cause,
    });
  }
}

const unusableLocation = () =>
  new PortError("unavailable", "GitHub redirected without a usable location.");

/** Where a redirect points, as long as that is https or the same origin as the request. */
export function redirectTarget(url: string, location: string | null): string {
  if (!location) {
    throw unusableLocation();
  }

  let target: URL;
  try {
    target = new URL(location, url);
  } catch {
    throw unusableLocation();
  }

  if (target.protocol !== "https:" && target.origin !== new URL(url).origin) {
    throw new PortError("unavailable", "GitHub redirected to a URL that is not https.");
  }

  return target.toString();
}
