import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { OfficeDoctor } from "./doctor/index.js";
import type { Office, OfficeHealth } from "./office.types.js";
import type { HealthServer } from "./types.js";

type Answer = { status: number; body: unknown };
type HealthOffice = Pick<Office, "health"> & { parts?: { doctor?: OfficeDoctor } };

const live = (h: OfficeHealth) => h.state !== "stopped" && h.state !== "stopping";

const probe =
  (ok: (h: OfficeHealth) => boolean) =>
  async (office: HealthOffice): Promise<Answer> => {
    const health = await office.health();
    return { status: ok(health) ? 200 : 503, body: health };
  };

const doctor =
  (run: boolean) =>
  async (office: HealthOffice): Promise<Answer> => {
    const d = office.parts?.doctor;
    if (!d) {
      return { status: 404, body: { error: "This office has no doctor." } };
    }

    if (run) {
      await d.run();
    }

    return { status: 200, body: await d.health() };
  };

/** What each method and path answers; anything else is 404. */
const ROUTES: Record<string, (office: HealthOffice) => Promise<Answer>> = {
  "GET /healthz": probe((h) => live(h) && (h.state !== "running" || h.ok)),
  "GET /readyz": probe((h) => h.ok),
  "GET /doctor": doctor(false),
  "POST /doctor": doctor(true),
};

function handle(office: HealthOffice, req: IncomingMessage, res: ServerResponse) {
  const route = ROUTES[`${req.method} ${(req.url ?? "").split("?")[0]}`];
  if (!route) {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
    return;
  }

  route(office).then(
    (a) =>
      res
        .writeHead(a.status, { "content-type": "application/json" })
        .end(`${JSON.stringify(a.body)}\n`),
    () => res.writeHead(503, { "content-type": "application/json" }).end('{"ok":false}\n'),
  );
}

/**
 * The container contract's probes. `/healthz` says whether the office is up and its parts are fine (503 otherwise,
 * so the platform restarts it); `/readyz` says it is running and can take agents (503 while starting or stopping).
 * `/doctor` gives the stored doctor checks (`GET`), or runs the office's checks first (`POST`), for `ost doctor
 * --via-office`.
 */
export function createHealthServer(
  office: HealthOffice,
  port: number,
  host?: string,
): HealthServer {
  let http: Server | undefined;
  return {
    async start() {
      http = createServer((req, res) => handle(office, req, res));
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
