import type { StandInReply } from "./types.js";

/** The status, headers and body bytes of a reply, as both the fetch and the Node adapters send them. */
export function encodeReply(reply: StandInReply): {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array | string | null;
} {
  const status = reply.status ?? 200;
  if (reply.buffer) {
    return { status, headers: reply.headers ?? {}, body: reply.buffer };
  }

  const text = reply.text !== undefined;
  const type = text ? "text/plain" : "application/json";
  const empty = status === 304 || status === 204;
  return {
    status,
    headers: { "content-type": type, ...reply.headers },
    body: empty ? null : (reply.text ?? JSON.stringify(reply.body ?? {})),
  };
}

/** A reply as a fetch `Response`. */
export function toResponse(reply: StandInReply): Response {
  const { status, headers, body } = encodeReply(reply);
  return new Response(typeof body === "string" || body === null ? body : body.slice(), {
    status,
    headers,
  });
}
