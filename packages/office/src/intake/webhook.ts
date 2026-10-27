import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { PortError, type Logger } from "@outstaff/core";
import type { WebhookParser, WebhookServer } from "./types.js";

export const MAX_WEBHOOK_BYTES = 1_000_000;

const STATUS: Record<string, number> = {
  forbidden: 401,
  invalid: 400,
  unsupported: 404,
  rate_limited: 429,
};

function flatten(headers: IncomingHttpHeaders): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
  }

  return out;
}

/** `POST /webhooks/<source>`; the adapter owns signature checks and payload parsing. */
export function createWebhookServer(opts: {
  port: number;
  host?: string;
  sources: Record<string, WebhookParser>;
  logger: Logger;
}): WebhookServer {
  const host = opts.host ?? "0.0.0.0";
  const server: Server = createServer((req, res) => {
    const reply = (status: number, message: string) => {
      res.writeHead(status, { "content-type": "text/plain" });
      res.end(message);
    };

    const match = /^\/webhooks\/([a-z]+)\/?$/.exec((req.url ?? "").split("?")[0]!);
    const parse = match ? opts.sources[match[1]!] : undefined;
    if (!parse) {
      return reply(404, "unknown webhook source");
    }

    if (req.method !== "POST") {
      return reply(405, "method not allowed");
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_WEBHOOK_BYTES) {
        tooBig = true;
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      if (tooBig) {
        return reply(413, "payload too large");
      }

      parse(flatten(req.headers), Buffer.concat(chunks).toString("utf8")).then(
        () => reply(202, "accepted"),
        (error: unknown) => {
          if (error instanceof PortError) {
            opts.logger.warn("webhook rejected", { source: match![1], code: error.code });
            return reply(STATUS[error.code] ?? 502, error.code);
          }

          opts.logger.error("webhook failed", { source: match![1], error: String(error) });
          reply(500, "error");
        },
      );
    });

    req.on("error", () => reply(400, "bad request"));
  });

  return {
    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(opts.port, host, () => {
          const addr = server.address();
          if (addr && typeof addr === "object") {
            resolve({ host, port: addr.port });
          }
        });
      }),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
