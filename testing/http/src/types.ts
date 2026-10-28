/** A request as a stand-in's routes see it, whether it came through a fetch or a Node server. */
export interface StandInRequest {
  method: string;

  /** The decoded path, or `<origin><path>` for a route that serves another host. */
  path: string;
  query: URLSearchParams;
  headers: Headers;

  /** `:name` segments of the route's path. */
  params: Record<string, string>;

  /** The parsed JSON body, when there is one. */
  json: any; // oxlint-disable-line no-explicit-any

  /** The raw body. */
  raw: Uint8Array;

  /** The multipart body of an upload. */
  form?: FormData;
}

/** What a route answers when it needs more than a JSON body with status 200. */
export interface StandInReply {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;

  /** A body served as plain text instead of JSON. */
  text?: string;

  /** Raw bytes, served as they are. */
  buffer?: Uint8Array;
}

export type Handler = (req: StandInRequest) => StandInReply | unknown | Promise<unknown>;

export interface Route {
  method: string;

  /** `:name` segments capture a decoded path segment; a trailing `*` matches the rest. */
  path: string;
  handler: Handler;
}

/** A request before routing: everything but the path parameters. */
export type Incoming = Omit<StandInRequest, "params">;

/** The matched route's request and its answer, or undefined when no route matches. */
export interface Served {
  req: StandInRequest;
  reply: StandInReply;
}

export type Dispatch = (incoming: Incoming) => Promise<Served | undefined>;
