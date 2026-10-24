import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { silentLogger, type Logger } from "@outstaff/core";
import {
  PROTOCOL_VERSION,
  decode,
  encode,
  type ErrorCode,
  type Message,
  type MessageOf,
  type MessageType,
  type PayloadOf,
} from "@outstaff/protocol";
import { WebSocketServer, type WebSocket } from "ws";
import type { Clock } from "../clock.js";
import type { AgentAuth } from "./auth.js";
import { ProtocolError, type ChatDesk, type Messaging, type WorkSource } from "./source.js";

export const CLOSE_AUTH = 4401;
export const CLOSE_VERSION = 4426;
export const CLOSE_REPLACED = 4409;

export interface ProtocolServerOptions {
  source: WorkSource;
  messaging?: Messaging;

  /** Receives the usage windows agents report. Without it a report is refused as unsupported. */
  usage?: { report(person: string, windows: PayloadOf<"usage">["windows"]): Promise<void> };
  chat?: ChatDesk;
  auth: AgentAuth;
  clock: Clock;
  logger?: Logger;

  /** 0 picks a free port. */
  port: number;
  host?: string;

  /** Agents must send a message at least this often. Default 15000. */
  heartbeatMs?: number;

  /** How long a new connection may stay silent before `hello`. Default 10000. */
  helloTimeoutMs?: number;

  /** How often the queues of connected people are checked for new work. Default 5000. */
  pollMs?: number;
  officeVersion?: string;
}

export interface ProtocolServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  port(): number;

  /** Handles of the people with a live, authenticated connection. */
  connected(): string[];

  /** Tells the server that work may be waiting for a person; the scheduler calls this after enqueueing. */
  notify(person: string): void;
}

interface Connection {
  ws: WebSocket;
  person: string | undefined;

  /** Offers already sent on this connection, so a poll does not repeat them. */
  offered: Set<string>;
  queue: Promise<void>;
  cancelTimer: (() => void) | undefined;
}

const MAX_FRAME = 1024 * 1024;

export function createProtocolServer(opts: ProtocolServerOptions): ProtocolServer {
  const { source, auth, clock } = opts;
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

  function deliver(person: string) {
    const run = async () => {
      const c = conns.get(person);
      if (!c || c.ws.readyState !== c.ws.OPEN) {
        return;
      }

      const outstanding = await source.outstanding(person);
      for (const { offer, accepted } of outstanding) {
        if (!accepted && !c.offered.has(offer.workItem.id)) {
          c.offered.add(offer.workItem.id);
          send(c, "offer", offer);
        }
      }

      // The work item and the chat sessions run in lanes of their own: offer until nothing more can start.
      for (let offer = await source.next(person); offer; offer = await source.next(person)) {
        c.offered.add(offer.workItem.id);
        send(c, "offer", offer);
      }
    };

    const prior = deliveries.get(person) ?? Promise.resolve();
    const next = prior.then(run).catch((err: unknown) => {
      log.error("offer delivery failed", { person, error: String(err) });
    });

    deliveries.set(person, next);
  }

  function desk(): ChatDesk {
    if (!opts.chat) {
      throw new ProtocolError("unsupported", "This office does not take chat requests.");
    }

    return opts.chat;
  }

  async function handleRequest(c: Connection, person: string, m: Message) {
    const reply = <T extends MessageType>(type: T, payload: PayloadOf<T>) =>
      send(c, type, payload, m.id);

    switch (m.type) {
      case "ping":
        return reply("pong", {});
      case "pong":
        return;
      case "heartbeat":
        await source.heartbeat(person, m.payload.workItemId);
        return reply("ack", {});
      case "accept":
        await source.accept(person, m.payload.workItemId);
        return reply("ack", {});
      case "decline":
        await source.decline(person, m.payload.workItemId, m.payload.reason);
        c.offered.delete(m.payload.workItemId);
        return reply("ack", {});
      case "progress":
        await source.progress(person, m.payload.workItemId, m.payload.text);
        return reply("ack", {});
      case "usage":
        if (!opts.usage) {
          throw new ProtocolError("unsupported", "This office does not take usage reports.");
        }

        await opts.usage.report(person, m.payload.windows);
        return reply("ack", {});
      case "session":
        await source.setSession(person, m.payload.workItemId, m.payload.sessionId);
        return reply("ack", {});
      case "journal":
        await source.journal(person, m.payload.workItemId, m.payload.text);
        return reply("ack", {});
      case "handback": {
        const { workItemId, ...result } = m.payload;
        await source.handBack(person, workItemId, result);
        await opts.messaging?.onHandBack?.(workItemId, result.status);
        reply("ack", {});
        return deliver(person);
      }

      case "fail":
        await source.fail(person, m.payload.workItemId, m.payload.reason);
        reply("ack", {});
        return deliver(person);
      case "ask": {
        if (!opts.messaging) {
          throw new ProtocolError("unsupported", "This office does not route questions.");
        }

        return reply("ask_result", await opts.messaging.ask(person, m.payload));
      }

      case "answer": {
        if (!opts.messaging) {
          throw new ProtocolError("unsupported", "This office does not route questions.");
        }

        await opts.messaging.answer(person, m.payload.questionId, m.payload.answer);
        return reply("ack", {});
      }

      case "roster":
        return reply(
          "roster_result",
          opts.messaging?.roster
            ? await opts.messaging.roster()
            : { members: await source.roster() },
        );
      case "work_list":
        return reply("work_list_result", {
          items: await source.list(
            person,
            m.payload.workItemId === undefined ? {} : { workItemId: m.payload.workItemId },
          ),
        });
      case "work_move":
        return reply("work_move_result", {
          item: await source.move(person, m.payload.workItemId, m.payload.status),
        });
      case "work_place":
        return reply("work_move_result", {
          item: await source.place(
            person,
            m.payload.workItemId,
            m.payload.position,
            m.payload.relativeTo,
          ),
        });
      case "chat_message":
        return reply("chat_message_result", await desk().message(person, m.payload));
      case "chat_report":
        return reply(
          "chat_report_result",
          await desk().report(person, m.payload.workItemId, m.payload.kind),
        );
      case "work_link":
        return reply(
          "work_link_result",
          await desk().linkTicket(person, m.payload.workItemId, m.payload.ticket),
        );
      case "work_queue":
        return reply(
          "work_queue_result",
          await desk().queueWork(person, m.payload.workItemId, {
            title: m.payload.title,
            body: m.payload.body,
          }),
        );
      case "work_attach":
        return reply(
          "work_attach_result",
          await desk().attachWork(person, m.payload.workItemId, {
            target: m.payload.target,
            confirmed: m.payload.confirmed,
            ...(m.payload.request ? { request: m.payload.request } : {}),
          }),
        );
      case "current_work":
        return reply("current_work_result", { text: await desk().currentWork(person) });
      default:
        throw new ProtocolError("invalid", `Agents do not send "${m.type}".`);
    }
  }

  async function handleHello(c: Connection, m: MessageOf<"hello">) {
    const { person, token, protocolVersion } = m.payload;
    if (protocolVersion !== PROTOCOL_VERSION) {
      sendError(
        c,
        "version_mismatch",
        `Protocol version ${protocolVersion} is not supported; this office speaks ${PROTOCOL_VERSION}.`,
        m.id,
      );

      c.ws.close(CLOSE_VERSION, "version mismatch");
      return;
    }

    if (!(await auth.verify(person, token))) {
      log.warn("agent authentication failed", { person });
      sendError(c, "auth_failed", "Unknown person or wrong token.", m.id);
      c.ws.close(CLOSE_AUTH, "authentication failed");
      return;
    }

    if (c.ws.readyState !== c.ws.OPEN) {
      return;
    }

    const old = conns.get(person);
    c.person = person;
    conns.set(person, c);
    if (old) {
      sendError(old, "replaced", "Another connection for this person took over.");
      old.ws.close(CLOSE_REPLACED, "replaced");
    }

    armIdle(c, heartbeatMs * 3);
    const outstanding = await source.outstanding(person);
    send(
      c,
      "welcome",
      {
        protocolVersion: PROTOCOL_VERSION,
        heartbeatMs,
        resume: outstanding.filter((o) => o.accepted).map((o) => o.offer.workItem.id),
      },
      m.id,
    );

    log.info("agent connected", { person });
    deliver(person);
  }

  async function onFrame(c: Connection, raw: string) {
    const decoded = decode(raw);
    if (!decoded.ok) {
      sendError(c, decoded.code, decoded.message, decoded.id);
      return;
    }

    const m = decoded.message;
    if (c.person === undefined) {
      if (m.type !== "hello") {
        sendError(c, "unauthenticated", "Send hello first.", m.id);
        c.ws.close(CLOSE_AUTH, "unauthenticated");
        return;
      }

      c.cancelTimer?.();
      await handleHello(c, m);
      return;
    }

    armIdle(c, heartbeatMs * 3);
    try {
      if (m.type === "hello") {
        throw new ProtocolError("invalid", "Already authenticated.");
      }

      await handleRequest(c, c.person, m);
    } catch (err) {
      if (err instanceof ProtocolError) {
        sendError(c, err.code, err.message, m.id);
      } else {
        log.error("agent request failed", { person: c.person, type: m.type, error: String(err) });
        sendError(c, "failed", "The office could not handle the request.", m.id);
      }
    }
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
      // Messages of one connection are handled in order.
      c.queue = c.queue
        .then(() => onFrame(c, data.toString("utf8")))
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
  };
}
