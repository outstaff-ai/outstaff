import { PortError, silentLogger } from "@outstaff/core";
import {
  PROTOCOL_VERSION,
  decode,
  encode,
  type ErrorCode,
  type Message,
  type MessageType,
  type PayloadOf,
  type QueuedReport,
} from "@outstaff/protocol";
import { WebSocket } from "ws";
import { FATAL, unavailable } from "./errors.js";
import { officeMethods } from "./methods.js";
import { createOfferQueue } from "./offers.js";
import { createRequests } from "./requests.js";
import type {
  ClientClock,
  ClientSocket,
  ConnectionState,
  OfficeConnection,
  OfficeConnectionOptions,
} from "./types.js";

export const systemClientClock: ClientClock = {
  now: () => new Date(),
  setTimeout(fn, ms) {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};

export function createOfficeConnection(opts: OfficeConnectionOptions): OfficeConnection {
  const clock = opts.clock ?? systemClientClock;
  const log = opts.logger ?? silentLogger;
  const open = opts.socket ?? ((url: string) => new WebSocket(url) as unknown as ClientSocket);
  const baseMs = opts.backoff?.baseMs ?? 1_000;
  const maxMs = opts.backoff?.maxMs ?? 30_000;
  const random = opts.random ?? Math.random;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;

  let state: ConnectionState = "idle";
  let socket: ClientSocket | undefined;
  let attempt = 0;
  let counter = 0;
  let rejected: { code: ErrorCode; message: string } | undefined;
  let resumeIds: string[] = [];
  let reportHandler: ((reports: QueuedReport[]) => void) | undefined;
  let heldReports: QueuedReport[] = [];
  // A work item and chat sessions run at once; each is kept alive by a heartbeat of its own.
  const activeItems = new Set<string>();
  let cancelBackoff: (() => void) | undefined;
  let cancelBeat: (() => void) | undefined;
  const offers = createOfferQueue();
  const { request, call, ack, settle, failPending, settleWaiters, whenConnected } = createRequests({
    clock,
    requestTimeoutMs,
    state: () => state,
    hasSocket: () => socket !== undefined,
    send: (type, payload) => rawSend(type, payload),
  });

  function deliverReports(list: QueuedReport[]) {
    if (reportHandler) {
      reportHandler(list);
    } else {
      heldReports.push(...list);
    }
  }

  function rawSend<T extends MessageType>(type: T, payload: PayloadOf<T>, replyTo?: string) {
    const id = `a${++counter}`;
    socket?.send(
      encode({
        id,
        ...(replyTo === undefined ? {} : { replyTo }),
        type,
        payload,
      } as unknown as Message),
    );

    return id;
  }

  function scheduleBeat(heartbeatMs: number) {
    cancelBeat?.();
    cancelBeat = clock.setTimeout(() => {
      if (state !== "connected") {
        return;
      }

      const beats =
        activeItems.size === 0
          ? [request("heartbeat", {}, heartbeatMs)]
          : [...activeItems].map((workItemId) => request("heartbeat", { workItemId }, heartbeatMs));

      Promise.all(beats)
        .then(() => scheduleBeat(heartbeatMs))
        .catch(() => {
          log.warn("office did not answer a heartbeat; reconnecting");
          socket?.terminate();
        });
    }, heartbeatMs);
  }

  function connect() {
    state = "connecting";
    const ws = open(opts.url);
    socket = ws;

    ws.on("open", () => {
      rawSend("hello", {
        person: opts.person,
        token: opts.token,
        protocolVersion: PROTOCOL_VERSION,
        agentVersion: opts.agentVersion,
      });
    });

    ws.on("message", (data) => {
      const decoded = decode(data.toString());
      if (!decoded.ok) {
        log.warn("unreadable message from the office", { problem: decoded.message });
        return;
      }

      const m = decoded.message;
      if (m.type === "welcome") {
        attempt = 0;
        state = "connected";
        resumeIds = m.payload.resume;
        if (m.payload.reports?.length) {
          deliverReports(m.payload.reports);
        }

        scheduleBeat(m.payload.heartbeatMs);
        settleWaiters();
        return;
      }

      if (m.type === "offer") {
        offers.push(m.payload);
        return;
      }

      if (m.type === "reports") {
        deliverReports(m.payload.reports);
        return;
      }

      if (m.type === "ping") {
        rawSend("pong", {}, m.id);
        return;
      }

      if (settle(m)) {
        return;
      }

      if (m.type === "error") {
        if (FATAL.includes(m.payload.code)) {
          rejected = m.payload;
        } else {
          log.warn("error from the office", m.payload);
        }
      }
    });

    ws.on("error", (err) => log.warn("connection error", { error: err.message }));

    ws.on("close", () => {
      if (socket !== ws) {
        return;
      }

      socket = undefined;
      cancelBeat?.();
      failPending(unavailable("The connection to the office was lost."));
      if (state === "stopped") {
        return;
      }

      if (rejected) {
        state = "rejected";
        settleWaiters(new PortError("forbidden", rejected.message));
        offers.end();
        return;
      }

      const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
      const delay = Math.round(ceiling / 2 + (ceiling / 2) * random());
      attempt += 1;
      state = "backoff";
      log.info("reconnecting to the office", { delayMs: delay });
      cancelBackoff = clock.setTimeout(() => {
        cancelBackoff = undefined;
        if (state === "backoff") {
          connect();
        }
      }, delay);
    });
  }

  return {
    start() {
      if (state === "idle") {
        connect();
      }
    },

    async stop() {
      state = "stopped";
      cancelBackoff?.();
      cancelBeat?.();
      failPending(unavailable("The client stopped."));
      settleWaiters(unavailable("The client stopped."));
      offers.end();
      socket?.close(1000);
      socket = undefined;
    },

    state: () => state,
    rejection: () => rejected,
    resume: () => [...resumeIds],
    onReports(handler) {
      reportHandler = handler;
      if (heldReports.length) {
        const held = heldReports;
        heldReports = [];
        handler(held);
      }
    },

    whenConnected,
    offers: () => offers.iterable(() => state === "stopped" || state === "rejected"),
    ...officeMethods(call, ack, activeItems),
  };
}
