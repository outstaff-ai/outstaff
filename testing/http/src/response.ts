import type { StandInReply } from "./types.js";

/** The body of a reply that is not raw bytes: none for 204 and 304, else its text or its JSON. */
const bodyOf = (reply: StandInReply, status: number): string | null =>
  status === 304 || status === 204 ? null : (reply.text ?? JSON.stringify(reply.body ?? {}));

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

  const type = reply.text === undefined ? "application/json" : "text/plain";
  return {
    status,
    headers: { "content-type": type, ...reply.headers },
    body: bodyOf(reply, status),
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
