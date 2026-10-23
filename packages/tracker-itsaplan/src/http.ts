import { PortError, type PortErrorCode } from "@outstaff/core";

export interface HttpConfig {
  fetch: typeof fetch;
  apiUrl: string;

  /** Sent as `Origin`, which the API checks on writes. */
  webUrl: string;
  apiKey: string;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

const DEFAULT_RETRY_MS = 30_000;

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
  constructor(private readonly cfg: HttpConfig) {}

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(`${this.cfg.apiUrl}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) {
        url.searchParams.set(k, String(v));
      }
    }

    let res: Response;
    try {
      res = await this.cfg.fetch(url, {
        method,
        headers: {
          "x-api-key": this.cfg.apiKey,
          accept: "application/json",
          origin: this.cfg.webUrl,
          ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      });
    } catch (cause) {
      throw new PortError("unavailable", `Its a Plan is unreachable: ${String(cause)}`, { cause });
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
}
