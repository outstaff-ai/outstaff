import type { Dispatch, Route, StandInReply } from "./types.js";

type Match = (path: string) => Record<string, string> | undefined;

const segmentMatches = (pattern: string, segment: string, params: Record<string, string>) => {
  if (pattern.startsWith(":")) {
    params[pattern.slice(1)] = decodeURIComponent(segment);
    return true;
  }

  return pattern === segment;
};

/** Compiles a route path into a matcher that returns its parameters. */
export function compile(pattern: string): Match {
  const parts = pattern.split("/");
  return (path) => {
    const segs = path.split("/");
    const params: Record<string, string> = {};
    for (const [i, part] of parts.entries()) {
      if (part === "*") {
        return params;
      }

      const seg = segs[i];
      if (seg === undefined || !segmentMatches(part, seg, params)) {
        return undefined;
      }
    }

    return segs.length === parts.length ? params : undefined;
  };
}

const REPLY_KEYS = new Set(["status", "headers", "body", "text", "buffer"]);

/** Whether a handler's answer is a reply (status, headers, body...) rather than a JSON body. */
export const isReply = (v: unknown): v is StandInReply =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  Object.keys(v).length > 0 &&
  Object.keys(v).every((k) => REPLY_KEYS.has(k));

/** Routes requests by method and path; the first matching route answers. */
export function createRouter(routes: Route[]): Dispatch {
  const compiled = routes.map((route) => ({ route, match: compile(route.path) }));
  return async (incoming) => {
    for (const { route, match } of compiled) {
      const params = route.method === incoming.method ? match(incoming.path) : undefined;
      if (params) {
        const req = { ...incoming, params };
        const out = await route.handler(req);
        return { req, reply: isReply(out) ? out : { body: out } };
      }
    }

    return undefined;
  };
}
