import { PortError, type PortErrorCode } from "@outstaff/core";
import { RETRY_AFTER_BURST_MS, pacerFor, realClock, type Pacer } from "./pacing.js";
import type { Clock, HttpConfig, RequestOptions } from "./types.js";

const DEFAULT_RETRY_MS = 30_000;

/** Repeating these changes nothing, so a refused one can be sent again. */
const IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "DELETE"]);

export function errorCode(status: number): PortErrorCode {
  if (status === 401 || status === 403) {
    return "forbidden";
  }

  if (status === 404 || status === 410) {
    return "not_found";
  }

  if (status === 409) {
    return "conflict";
  }

  if (status === 429) {
    return "rate_limited";
  }

  if (status >= 500) {
    return "unavailable";
  }

  return "invalid";
}

function withQuery(href: string, { query }: RequestOptions): URL {
  const url = new URL(href);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined) {
      url.searchParams.set(k, String(v));
    }
  }

  return url;
}

/** The JSON of a response body; undefined when it is empty or not JSON. */
function parseJson(raw: string): unknown {
  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** A Retry-After in seconds, or the default wait when there is none. */
function retryAfterMs(res: Response): number {
  const retry = Number(res.headers.get("retry-after"));
  return Number.isFinite(retry) && retry > 0 ? retry * 1000 : DEFAULT_RETRY_MS;
}

function requestError(
  method: string,
  path: string,
  res: Response,
  raw: string,
  data: unknown,
): PortError {
  const body = (data ?? {}) as { error?: string; code?: string };
  const code = errorCode(res.status);
  const reason = body.error ?? (raw.slice(0, 200) || res.statusText);
  return new PortError(
    code,
    `Its a Plan ${method} ${path} -> ${res.status}${body.code ? ` ${body.code}` : ""}: ${reason}`,
    code === "rate_limited" ? { retryAfterMs: retryAfterMs(res) } : {},
  );
}

/** A small typed JSON client. Every failure leaves here as a PortError. */
export class ItsaplanHttp {
  private readonly pacer: Pacer;
  private readonly clock: Clock;

  constructor(private readonly cfg: HttpConfig) {
    this.pacer = cfg.pacer ?? pacerFor(cfg.apiUrl, cfg.apiKey);
    this.clock = cfg.clock ?? realClock;
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = withQuery(`${this.cfg.apiUrl}${path}`, opts);
    const res = await this.sendRetryingBurst(method, path, url, opts);
    const raw = await res.text();
    const data = parseJson(raw);
    if (!res.ok) {
      throw requestError(method, path, res, raw, data);
    }

    return data as T;
  }

  // Past its burst limit the service answers 500 until the key has been idle for a second.
  private async sendRetryingBurst(
    method: string,
    path: string,
    url: URL,
    opts: RequestOptions,
  ): Promise<Response> {
    const { res, burst } = await this.send(method, url, opts);
    if (res.status !== 500 || burst <= 1 || !IDEMPOTENT.has(method)) {
      return res;
    }

    this.cfg.log?.warn("rate limited", {
      method,
      path,
      status: res.status,
      retryInMs: RETRY_AFTER_BURST_MS,
    });

    await this.clock.sleep(RETRY_AFTER_BURST_MS);
    return (await this.send(method, url, opts)).res;
  }

  /** The bytes behind a path, for a file download. Failures leave as PortErrors like `request`. */
  async bytes(path: string): Promise<Uint8Array> {
    const url = new URL(`${this.cfg.apiUrl}${path}`);
    const { res } = await this.send("GET", url, {});
    if (!res.ok) {
      const code = errorCode(res.status);
      throw new PortError(code, `Its a Plan GET ${path} -> ${res.status}: ${res.statusText}`);
    }

    return new Uint8Array(await res.arrayBuffer());
  }

  private async send(
    method: string,
    url: URL,
    { body, form }: RequestOptions,
  ): Promise<{ res: Response; burst: number }> {
    const burst = await this.pacer.acquire();
    try {
      const res = await this.cfg.fetch(url, {
        method,
        headers: {
          "x-api-key": this.cfg.apiKey,
          accept: "application/json",
          origin: this.cfg.webUrl,
          ...(body === undefined || form ? {} : { "content-type": "application/json" }),
        },
        ...(form ? { body: form } : body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      return { res, burst };
    } catch (cause) {
      throw new PortError("unavailable", `Its a Plan is unreachable: ${String(cause)}`, { cause });
    }
  }
}
