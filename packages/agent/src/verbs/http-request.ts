import { PortError } from "@outstaff/core";
import { readInputFile } from "./files.js";
import type { AgentEnv, NetworkAccess, VerbContext } from "./types.js";

const TIMEOUT_MS = 30_000;
export const MAX_BODY = 200_000;

/** Headers the grant decides, or that would let a request reach somewhere else than the granted origin. */
const FORBIDDEN_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "host",
  "cookie",
  "content-length",
  "connection",
  "transfer-encoding",
  "upgrade",
  "x-forwarded-host",
  "x-forwarded-for",
]);

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

export function parseHeaders(raw: string[]): [string, string][] {
  return raw.map((h) => {
    const i = h.indexOf(":");
    const name = i > 0 ? h.slice(0, i).trim() : "";
    const value = i > 0 ? h.slice(i + 1).trim() : "";
    if (!HEADER_NAME.test(name) || /[\r\n]/.test(value)) {
      throw new PortError("invalid", `header "${name || h}" must be written name:value.`);
    }

    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
      throw new PortError(
        "invalid",
        `The ${name} header is set by the grant and cannot be given; the service's token is added for you.`,
      );
    }

    return [name, value];
  });
}

export async function readCapped(res: Response): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) {
    return { text: "", truncated: false };
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    chunks.push(value);
    size += value.length;
    if (size > MAX_BODY) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }

  const bytes = Buffer.concat(chunks).subarray(0, MAX_BODY);
  return { text: new TextDecoder().decode(bytes), truncated };
}

/** The parts of an `ost http` call that decide the request body. */
interface BodyInput {
  method: string;
  json?: string | undefined;
  dataFile?: string | undefined;
}

/**
 * The request body from `json` or `data-file`, refusing both at once and a body on GET or HEAD. A JSON body gets
 * `Content-Type: application/json` unless the caller set a content type.
 */
export function requestBody(
  env: AgentEnv,
  ctx: VerbContext,
  input: BodyInput,
  headers: [string, string][],
): string | undefined {
  if (input.json !== undefined && input.dataFile !== undefined) {
    throw new PortError("invalid", "Give json or data-file, not both.");
  }

  const body =
    input.json !== undefined
      ? jsonBody(input.json, headers)
      : input.dataFile !== undefined
        ? readInputFile(env, ctx, input.dataFile, "data file")
        : undefined;

  if (body !== undefined && (input.method === "GET" || input.method === "HEAD")) {
    throw new PortError("invalid", `${input.method} takes no body.`);
  }

  return body;
}

function jsonBody(json: string, headers: [string, string][]): string {
  try {
    JSON.parse(json);
  } catch {
    throw new PortError("invalid", "json is not valid JSON.");
  }

  if (!headers.some(([n]) => n.toLowerCase() === "content-type")) {
    headers.push(["Content-Type", "application/json"]);
  }

  return json;
}

/** The service's bearer token, if it has one; a token whose secret is missing is refused. */
export function serviceToken(
  env: AgentEnv,
  service: NetworkAccess["http"][number],
  name: string,
): string | undefined {
  try {
    return service.token?.();
  } catch {
    throw new PortError(
      "unavailable",
      `The token for ${name} is not provided to ${env.person}. Ask a human to add the secret named in its network grant.`,
    );
  }
}

/** Sends the request without following redirects; a service that does not answer becomes `unanswered(why)`. */
export async function sendRequest(
  net: NetworkAccess,
  url: URL,
  init: { method: string; headers: Headers; body: string | undefined },
  unanswered: (why: string) => string,
): Promise<Response> {
  try {
    return await (net.fetch ?? fetch)(url, {
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const why = (e as Error).name === "TimeoutError" ? "timed out" : String((e as Error).message);
    throw new PortError("unavailable", unanswered(why));
  }
}
