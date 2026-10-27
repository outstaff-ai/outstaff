import type { IncomingMessage, ServerResponse } from "node:http";
import { encodeReply } from "./response.js";
import type { Incoming, StandInReply } from "./types.js";

/** Reads the whole body; the stand-ins are small and in memory. */
export const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

const headersOf = (req: IncomingMessage): Headers => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      headers.append(name, v);
    }
  }

  return headers;
};

const formOf = async (raw: Buffer, type: string): Promise<FormData | undefined> =>
  type.startsWith("multipart/form-data")
    ? new Response(new Uint8Array(raw), { headers: { "content-type": type } })
        .formData()
        .catch(() => undefined)
    : undefined;

/** A Node request as a stand-in request; a JSON body that does not parse is an error the caller answers 400. */
export async function incomingFromNode(req: IncomingMessage, raw: Buffer): Promise<Incoming> {
  const url = new URL(req.url ?? "/", "http://stand-in");
  const type = String(req.headers["content-type"] ?? "");
  const json = raw.length && type.includes("json") ? JSON.parse(raw.toString("utf8")) : undefined;
  const form = await formOf(raw, type);
  return {
    method: (req.method ?? "GET").toUpperCase(),
    path: decodeURIComponent(url.pathname),
    query: url.searchParams,
    headers: headersOf(req),
    json,
    raw: new Uint8Array(raw),
    ...(form ? { form } : {}),
  };
}

/** Sends a reply on a Node response. */
export function writeReply(res: ServerResponse, reply: StandInReply): void {
  const { status, headers, body } = encodeReply(reply);
  res.writeHead(status, headers).end(body ?? undefined);
}
