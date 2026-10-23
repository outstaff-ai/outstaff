import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Office } from "./office.js";

export interface HealthServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  port(): number;
}

/**
 * The container contract's probes. `/healthz` says whether the office is up and its parts are fine (503 otherwise,
 * so the platform restarts it); `/readyz` says it is running and can take agents (503 while starting or stopping).
 */
export function createHealthServer(
  office: Pick<Office, "health">,
  port: number,
  host?: string,
): HealthServer {
  let http: Server | undefined;
  return {
    async start() {
      http = createServer((req, res) => {
        const path = (req.url ?? "").split("?")[0];
        if ((path !== "/healthz" && path !== "/readyz") || req.method !== "GET") {
          res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
          return;
        }

        office.health().then(
          (health) => {
            const live = health.state !== "stopped" && health.state !== "stopping";
            const ok =
              path === "/healthz" ? live && (health.state !== "running" || health.ok) : health.ok;

            res
              .writeHead(ok ? 200 : 503, { "content-type": "application/json" })
              .end(`${JSON.stringify(health)}\n`);
          },
          () => res.writeHead(503, { "content-type": "application/json" }).end('{"ok":false}\n'),
        );
      });

      await new Promise<void>((resolve, reject) => {
        http?.once("error", reject);
        http?.listen(port, host ?? "0.0.0.0", () => resolve());
      });
    },

    async stop() {
      await new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()));
    },

    port() {
      const addr = http?.address();
      return addr && typeof addr === "object" ? (addr as AddressInfo).port : port;
    },
  };
}
