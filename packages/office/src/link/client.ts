import {
  LINK_VERSION,
  decodeLinkMessage,
  encodeLinkMessage,
  type LinkMessage,
  type LinkPayloadOf,
  type LinkRequest,
  type LinkResponse,
} from "@outstaff/protocol";
import { WebSocket } from "ws";
import type { OfficeLink, OfficeLinkOptions, LinkStatus } from "./link.types.js";
import { createNotifier } from "./notifications.js";
import { answer } from "./requests.js";

/** Close code for a service that speaks another link version. */
export const CLOSE_VERSION = 4426;

/**
 * Connects the office out to a service, answers its requests and notifies it of changes. Reconnects with capped
 * backoff; every failure is logged and shows in `status()`, and none reaches the office.
 */
export function createOfficeLink(opts: OfficeLinkOptions): OfficeLink {
  const { clock, logger } = opts;
  const pollMs = opts.pollMs ?? 1000;
  const pingMs = opts.pingMs ?? 15_000;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
  const baseMs = opts.backoff?.baseMs ?? 1000;
  const maxMs = opts.backoff?.maxMs ?? 60_000;
  const random = opts.random ?? Math.random;
  const status: LinkStatus = { state: "idle" };
  let ws: WebSocket | undefined;
  let attempt = 0;
  let busy: Promise<void> = Promise.resolve();
  const timers = new Map<string, () => void>();

  const timer = (name: string, ms: number, fn: () => void) => {
    timers.get(name)?.();
    timers.set(name, clock.setTimeout(fn, ms));
  };

  const clearTimers = () => {
    for (const cancel of timers.values()) {
      cancel();
    }

    timers.clear();
  };

  const fail = (what: string, error: unknown) => {
    status.lastError = `${what}: ${error instanceof Error ? error.message : String(error)}`;
    logger.warn(`office link: ${status.lastError}`);
  };

  const send = (m: LinkMessage) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(encodeLinkMessage(m));
      timer("ping", pingMs, () => send({ type: "ping", payload: {} }));
    }
  };

  const notifier = createNotifier(opts, send);

  /** One at a time, so notifications go out in order. */
  const serial = (fn: () => Promise<void>) => {
    busy = busy.then(fn).catch((error: unknown) => fail("could not notify the service", error));
    return busy;
  };

  const poll = () =>
    timer("poll", pollMs, () => {
      void serial(() => notifier.look()).then(() => status.state === "connected" && poll());
    });

  async function respond(r: LinkRequest) {
    let late!: (response: LinkResponse) => void;
    const timedOut = new Promise<LinkResponse>((resolve) => (late = resolve));
    const cancel = clock.setTimeout(
      () =>
        late({
          id: r.id,
          error: { code: "timeout", message: `No answer within ${requestTimeoutMs} ms.` },
        }),
      requestTimeoutMs,
    );

    const response = await Promise.race([answer(opts, r), timedOut]);
    cancel();
    send({ type: "response", payload: response });
  }

  function welcome(p: LinkPayloadOf<"welcome">) {
    if (p.version !== LINK_VERSION) {
      fail("the service speaks another link version", `${p.version}, not ${LINK_VERSION}`);

      ws?.close(CLOSE_VERSION, "version mismatch");
      return;
    }

    status.state = "connected";
    status.lastError = undefined;
    attempt = 0;
    logger.info("office link: connected", { office: p.office.id });
    send({ type: "hello", payload: { office: opts.identity } });
    void serial(() => notifier.begin()).then(poll);
  }

  /** A service that sends nothing for three ping intervals is gone, whatever the socket says. */
  const watchSilence = () =>
    timer("silence", pingMs * 3, () => {
      fail("the service went quiet", `no message for ${(pingMs * 3) / 1000} s`);
      ws?.terminate();
    });

  function onMessage(raw: string) {
    watchSilence();
    const decoded = decodeLinkMessage(raw);
    if (!decoded.ok) {
      if (decoded.id !== undefined) {
        const known = ["people", "events", "event", "item"].includes(decoded.method ?? "");
        send({
          type: "response",
          payload: {
            id: decoded.id,
            error: known
              ? { code: "invalid", message: decoded.problem }
              : { code: "unknown_method", message: `No method ${decoded.method ?? "(none)"}.` },
          },
        });
      }

      return;
    }

    const m = decoded.message;
    if (m.type === "welcome") {
      welcome(m.payload);
    } else if (m.type === "request" && status.state === "connected") {
      void respond(m.payload);
    } else if (m.type === "ping") {
      send({ type: "pong", payload: {} });
    }
  }

  function connect() {
    status.state = "connecting";
    const socket = new WebSocket(opts.url, {
      headers: {
        authorization: `Bearer ${opts.token}`,
        "outstaff-link-version": String(LINK_VERSION),
      },
    });

    ws = socket;
    socket.on("open", watchSilence);
    socket.on("message", (data: Buffer) => onMessage(data.toString("utf8")));
    socket.on("error", (error) => fail("connection failed", error));
    socket.on("close", () => {
      clearTimers();
      ws = undefined;
      if (status.state === "stopped") {
        return;
      }

      const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
      attempt += 1;
      status.state = "backoff";
      timer("reconnect", Math.round(ceiling / 2 + (ceiling / 2) * random()), connect);
    });
  }

  return {
    start() {
      if (status.state === "idle") {
        connect();
      }
    },

    async stop() {
      status.state = "stopped";
      clearTimers();
      const socket = ws;
      if (socket) {
        await new Promise<void>((resolve) => {
          socket.once("close", () => resolve());
          socket.terminate();
        });
      }

      await busy;
    },

    status: () => ({ ...status }),
  };
}
