import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { silentLogger } from "@outstaff/core";
import {
  decode,
  encode,
  type ErrorCode,
  type Message,
  type MessageType,
  type PayloadOf,
  type QueuedAct,
} from "@outstaff/protocol";
import { WebSocketServer, type WebSocket } from "ws";
import { CLOSE_AUTH } from "./constants.js";
import { answerAtOnce } from "./beats.js";
import { ProtocolError } from "./errors.js";
import { handleHello } from "./hello.js";
import { handleRequest } from "./requests.js";
import type { Offer } from "./source.types.js";
import type { Connection, HelloContext, ProtocolServer, ProtocolServerOptions } from "./types.js";

const MAX_FRAME = 1024 * 1024;

export function createProtocolServer(opts: ProtocolServerOptions): ProtocolServer {
  const { source, clock } = opts;
  const log = opts.logger ?? silentLogger;
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const helloTimeoutMs = opts.helloTimeoutMs ?? 10_000;
  const pollMs = opts.pollMs ?? 5_000;
  const conns = new Map<string, Connection>();
  const deliveries = new Map<string, Promise<void>>();
  let counter = 0;
  let http: Server | undefined;
  let wss: WebSocketServer | undefined;
  let cancelPoll: (() => void) | undefined;
  let running = false;

  function send<T extends MessageType>(
    c: Connection,
    type: T,
    payload: PayloadOf<T>,
    replyTo?: string,
  ) {
    if (c.ws.readyState !== c.ws.OPEN) {
      return;
    }

    const message = {
      id: `o${++counter}`,
      ...(replyTo === undefined ? {} : { replyTo }),
      type,
      payload,
    } as unknown as Message;

    c.ws.send(encode(message));
  }

  const sendError = (c: Connection, code: ErrorCode, message: string, replyTo?: string) =>
    send(c, "error", { code, message }, replyTo);

  function armIdle(c: Connection, ms: number) {
    c.cancelTimer?.();
    c.cancelTimer = clock.setTimeout(() => {
      log.info("agent connection timed out", { person: c.person });
      c.ws.terminate();
    }, ms);
  }

  function offerOn(c: Connection, person: string, offer: Offer) {
    c.offered.add(offer.workItem.id);
    send(c, "offer", offer);
    log.info("offered a work item", { person, item: offer.workItem.id });
  }

  function deliver(person: string) {
    const run = async () => {
      const c = conns.get(person);
      if (!c || c.ws.readyState !== c.ws.OPEN) {
        return;
      }

      const outstanding = await source.outstanding(person);
      for (const { offer, accepted } of outstanding) {
        if (!accepted && !c.offered.has(offer.workItem.id)) {
          offerOn(c, person, offer);
        }
      }

      // The work item and the chat sessions run in lanes of their own: offer until nothing more can start.
      for (let offer = await source.next(person); offer; offer = await source.next(person)) {
        offerOn(c, person, offer);
      }
    };

    const prior = deliveries.get(person) ?? Promise.resolve();
    const next = prior.then(run).catch((err: unknown) => {
      log.error("offer delivery failed", { person, error: String(err) });
    });

    deliveries.set(person, next);
  }

  function pushReports(person: string) {
    const c = conns.get(person);
    if (!c || !opts.chat) {
      return;
    }

    void opts.chat
      .queued(person)
      .then((reports) => {
        if (reports.length > 0) {
          send(c, "reports", { reports });
        }
      })
      .catch((err: unknown) => {
        log.warn("could not send the queued reports of an agent", { person, error: String(err) });
      });
  }

  function sendAct(person: string, act: QueuedAct): boolean {
    const c = conns.get(person);
    if (!c || c.ws.readyState !== c.ws.OPEN) {
      return false;
    }

    send(c, "act", act);
    return true;
  }

  const connected = (person: string) => {
    opts.onConnected?.(person);
    deliver(person);
  };

  const ctx: HelloContext = {
    opts,
    send,
    deliver,
    connected,
    conns,
    heartbeatMs,
    log,
    sendError,
    armIdle,
  };

  async function onFrame(c: Connection, m: Message) {
    if (c.person === undefined) {
      if (m.type !== "hello") {
        sendError(c, "unauthenticated", "Send hello first.", m.id);
        c.ws.close(CLOSE_AUTH, "unauthenticated");
        return;
      }

      c.cancelTimer?.();
      await handleHello(ctx, c, m);
      return;
    }

    // A heartbeat that came while the hello was handled waited in the queue.
    if (answerAtOnce(ctx, c, m)) {
      return;
    }

    armIdle(c, heartbeatMs * 3);
    try {
      if (m.type === "hello") {
        throw new ProtocolError("invalid", "Already authenticated.");
      }

      await handleRequest(ctx, c, c.person, m);
    } catch (err) {
      refuse(c, m, err);
    }
  }

  /** A `ProtocolError` goes back as it is; anything else the agent hears only failed, and the log keeps what and where. */
  function refuse(c: Connection, m: Message, err: unknown) {
    if (err instanceof ProtocolError) {
      sendError(c, err.code, err.message, m.id);
      return;
    }

    log.error("agent request failed", {
      person: c.person,
      type: m.type,
      id: m.id,
      error: String(err),
      ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
    });

    sendError(c, "failed", "The office could not handle the request.", m.id);
  }

  function onConnection(ws: WebSocket) {
    const c: Connection = {
      ws,
      person: undefined,
      offered: new Set(),
      queue: Promise.resolve(),
      cancelTimer: undefined,
    };

    c.cancelTimer = clock.setTimeout(() => {
      sendError(c, "unauthenticated", "No hello received in time.");
      ws.close(CLOSE_AUTH, "hello timeout");
    }, helloTimeoutMs);

    ws.on("message", (data: Buffer) => {
      const decoded = decode(data.toString("utf8"));
      if (decoded.ok && answerAtOnce(ctx, c, decoded.message)) {
        return;
      }

      // Requests of one connection are handled in order.
      c.queue = c.queue
        .then(() =>
          decoded.ok
            ? onFrame(c, decoded.message)
            : sendError(c, decoded.code, decoded.message, decoded.id),
        )
        .catch((err: unknown) => log.error("frame handling failed", { error: String(err) }));
    });

    ws.on("close", () => {
      c.cancelTimer?.();
      if (c.person !== undefined && conns.get(c.person) === c) {
        conns.delete(c.person);
        log.info("agent disconnected", { person: c.person });
      }
    });

    ws.on("error", (err: Error) => log.warn("agent socket error", { error: err.message }));
  }

  function schedulePoll() {
    cancelPoll = clock.setTimeout(() => {
      if (!running) {
        return;
      }

      for (const person of conns.keys()) {
        deliver(person);
      }

      schedulePoll();
    }, pollMs);
  }

  return {
    async start() {
      http = createServer((_req, res) => {
        res.writeHead(426, { "content-type": "text/plain" });
        res.end("Upgrade required: this is the agent connection endpoint.\n");
      });

      wss = new WebSocketServer({ server: http, path: "/agent", maxPayload: MAX_FRAME });
      wss.on("connection", onConnection);
      await new Promise<void>((resolve, reject) => {
        http?.once("error", reject);
        http?.listen(opts.port, opts.host ?? "0.0.0.0", () => resolve());
      });

      running = true;
      schedulePoll();
    },

    async stop() {
      running = false;
      cancelPoll?.();
      for (const c of conns.values()) {
        c.cancelTimer?.();
      }

      for (const client of wss?.clients ?? []) {
        client.terminate();
      }

      conns.clear();
      await new Promise<void>((resolve) => (wss ? wss.close(() => resolve()) : resolve()));
      await new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()));
      await Promise.allSettled(deliveries.values());
    },

    port() {
      const addr = http?.address();
      return addr && typeof addr === "object" ? (addr as AddressInfo).port : opts.port;
    },

    connected: () => [...conns.keys()],
    notify: (person) => deliver(person),
    reports: (person) => pushReports(person),
    act: sendAct,
  };
}
