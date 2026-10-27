import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

/** What a handler sees of a request. The body is read before routing, since the stub is small and in memory. */
export interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  params: Record<string, string>;
  raw: Buffer;

  /** The parsed JSON body, when there is one. */
  json: any; // oxlint-disable-line no-explicit-any
}

export interface Reply {
  status?: number;
  headers?: Record<string, string | string[]>;
  body?: unknown;
  buffer?: Buffer;
}

export type Handler = (req: Req) => Reply | unknown | Promise<Reply | unknown>;

export interface Route {
  method: string;

  /** `:name` captures a decoded path segment; a trailing `*` matches the rest. */
  path: string;
  handler: Handler;
}

const compile = (pattern: string) => {
  const parts = pattern.split("/");
  return (path: string): Record<string, string> | undefined => {
    const segs = path.split("/");
    const params: Record<string, string> = {};
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!;
      if (p === "*") {
        return params;
      }

      const s = segs[i];
      if (s === undefined) {
        return undefined;
      }

      if (p.startsWith(":")) {
        params[p.slice(1)] = decodeURIComponent(s);
      } else if (p !== s) {
        return undefined;
      }
    }

    return segs.length === parts.length ? params : undefined;
  };
};

const isReply = (v: unknown): v is Reply =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  Object.keys(v).length > 0 &&
  Object.keys(v).every((k) => k === "status" || k === "headers" || k === "body" || k === "buffer");

export const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

const BAD_JSON = Symbol("bad json");

/** The JSON body when the request declares one, `undefined` without one, `BAD_JSON` when it doesn't parse. */
function parseJson(req: IncomingMessage, body: Buffer): unknown {
  if (!body.length || !String(req.headers["content-type"] ?? "").includes("json")) {
    return undefined;
  }

  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return BAD_JSON;
  }
}

function writeReply(res: ServerResponse, out: unknown): void {
  const reply: Reply = isReply(out) ? out : { body: out };
  const status = reply.status ?? 200;
  if (reply.buffer) {
    res.writeHead(status, reply.headers ?? {}).end(reply.buffer);
    return;
  }

  const noBody = status === 304 || status === 204;
  res
    .writeHead(status, { "content-type": "application/json", ...reply.headers })
    .end(noBody ? undefined : JSON.stringify(reply.body ?? {}));
}

export function router(routes: Route[]) {
  const compiled = routes.map((r) => ({ r, match: compile(r.path) }));
  const find = (method: string, pathname: string) => {
    for (const { r, match } of compiled) {
      const params = r.method === method ? match(pathname) : undefined;
      if (params) {
        return { r, params };
      }
    }

    return undefined;
  };

  return async (req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://stub");
    const method = (req.method ?? "GET").toUpperCase();
    const found = find(method, url.pathname);
    if (!found) {
      return false;
    }

    const json = parseJson(req, body);
    if (json === BAD_JSON) {
      res.writeHead(400, { "content-type": "application/json" }).end('{"message":"bad json"}');
      return true;
    }

    const out = await found.r.handler({
      method,
      path: decodeURIComponent(url.pathname),
      query: url.searchParams,
      headers: req.headers,
      params: found.params,
      raw: body,
      json,
    });

    writeReply(res, out);
    return true;
  };
}
