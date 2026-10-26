import { PortError, type Logger, type PortErrorCode } from "@outstaff/core";
import { RETRY_AFTER_BURST_MS, pacerFor, realClock, type Clock, type Pacer } from "./pacing.js";

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

/** A small typed JSON client. Every failure leaves here as a PortError. */
export class ItsaplanHttp {
  private readonly pacer: Pacer;
  private readonly clock: Clock;

  constructor(private readonly cfg: HttpConfig) {
    this.pacer = cfg.pacer ?? pacerFor(cfg.apiUrl, cfg.apiKey);
    this.clock = cfg.clock ?? realClock;
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(`${this.cfg.apiUrl}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) {
        url.searchParams.set(k, String(v));
      }
    }

    let { res, burst } = await this.send(method, url, opts);
    // Past its burst limit the service answers 500 until the key has been idle for a second.
    if (res.status === 500 && burst > 1 && IDEMPOTENT.has(method)) {
      this.cfg.log?.warn("rate limited", {
        method,
        path,
        status: res.status,
        retryInMs: RETRY_AFTER_BURST_MS,
      });

      await this.clock.sleep(RETRY_AFTER_BURST_MS);
      ({ res } = await this.send(method, url, opts));
    }

    const raw = await res.text();
    let data: unknown = undefined;
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = undefined;
      }
    }

    if (!res.ok) {
      const body = (data ?? {}) as { error?: string; code?: string };
      const code = errorCode(res.status);
      const retry = Number(res.headers.get("retry-after"));
      throw new PortError(
        code,
        `Its a Plan ${method} ${path} -> ${res.status}${body.code ? ` ${body.code}` : ""}: ${body.error ?? (raw.slice(0, 200) || res.statusText)}`,
        code === "rate_limited"
          ? { retryAfterMs: Number.isFinite(retry) && retry > 0 ? retry * 1000 : DEFAULT_RETRY_MS }
          : {},
      );
    }

    return data as T;
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
