import type { Logger } from "@outstaff/core";
import type { ErrorCode, MessageType, PayloadOf } from "@outstaff/protocol";
import type { WebSocket } from "ws";
import type { Clock } from "#/types.js";
import type { ChatDesk, DocLinks, Messaging, TicketPrs, WorkSource } from "./source.types.js";

export interface AgentAuth {
  /** True only when the person has a token and `token` matches it. Takes the same time either way. */
  verify(person: string, token: string): Promise<boolean>;
  has(person: string): boolean;
}

export interface ProtocolServerOptions {
  source: WorkSource;
  messaging?: Messaging;

  /** Receives the usage windows agents report. Without it a report is refused as unsupported. */
  usage?: { report(person: string, windows: PayloadOf<"usage">["windows"]): Promise<void> };
  chat?: ChatDesk;

  /** Answers `ticket_prs`. Without it the request is refused as unsupported. */
  tickets?: TicketPrs;

  /** Takes `doc_link`. Without it the request is refused as unsupported. */
  docs?: DocLinks;

  /** Called once an agent's connection is authenticated, before its work is offered. */
  onConnected?: (person: string) => void;
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

  /** Sends the person's queued reports to its agent now, if it is connected; otherwise the next `welcome` carries them. */
  reports(person: string): void;
}

/** One agent socket, authenticated once `person` is set. */
export interface Connection {
  ws: WebSocket;
  person: string | undefined;

  /** Offers already sent on this connection, so a poll does not repeat them. */
  offered: Set<string>;
  queue: Promise<void>;
  cancelTimer: (() => void) | undefined;
}

/** What a request handler needs from the server it runs in. */
export interface RequestContext {
  opts: ProtocolServerOptions;
  send<T extends MessageType>(
    c: Connection,
    type: T,
    payload: PayloadOf<T>,
    replyTo?: string,
  ): void;
  deliver(person: string): void;
}

/** One request of an authenticated agent, as its handler sees it. */
export interface AgentRequest<T extends MessageType> {
  ctx: RequestContext;
  c: Connection;
  person: string;
  payload: PayloadOf<T>;

  /** Sends the answer to this request. */
  reply<R extends MessageType>(type: R, payload: PayloadOf<R>): void;
}

export type RequestHandler<T extends MessageType> = (r: AgentRequest<T>) => Promise<void> | void;

/** The handlers of the requests agents send, by message type. */
export type RequestHandlers = { [T in MessageType]?: RequestHandler<T> };

/** What the `hello` handshake needs from the server: the request context plus the live connections. */
export interface HelloContext extends RequestContext {
  conns: Map<string, Connection>;
  heartbeatMs: number;
  log: Logger;
  sendError(c: Connection, code: ErrorCode, message: string, replyTo?: string): void;
  armIdle(c: Connection, ms: number): void;

  /** The person's connection is authenticated: tell the office, then offer their work. */
  connected(person: string): void;
}
