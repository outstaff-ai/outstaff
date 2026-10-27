import type { Logger } from "@outstaff/core";
import type {
  ErrorCode,
  Link,
  Message,
  MessageType,
  PayloadOf,
  QueuedReport,
} from "@outstaff/protocol";
import type { OfficeClient } from "../verbs/office.types.js";

export type Offer = PayloadOf<"offer">;

/** The same shape as the office's clock, so one fake serves both. */
export interface ClientClock {
  now(): Date;
  setTimeout(fn: () => void, ms: number): () => void;
}

/** The part of a WebSocket the client uses; `ws` satisfies it. */
export interface ClientSocket {
  send(data: string): void;
  close(code?: number): void;
  terminate(): void;
  on(event: "open", listener: () => void): unknown;
  on(event: "message", listener: (data: { toString(): string }) => void): unknown;
  on(event: "close", listener: (code: number) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

export interface OfficeConnectionOptions {
  /** For example ws://office:8787/agent. */
  url: string;
  person: string;
  token: string;
  agentVersion: string;
  clock?: ClientClock;
  logger?: Logger;
  socket?: (url: string) => ClientSocket;
  backoff?: { baseMs?: number; maxMs?: number };

  /** 0..1, for jitter. Default Math.random. */
  random?: () => number;

  /** How long a request waits for a connection and for its answer. Default 30000. */
  requestTimeoutMs?: number;
}

export type ConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "backoff"
  | "stopped"
  | "rejected";

export interface OfficeConnection extends OfficeClient {
  start(): void;
  stop(): Promise<void>;
  state(): ConnectionState;

  /** Why the office refused the connection, when `state()` is `rejected`. */
  rejection(): { code: ErrorCode; message: string } | undefined;

  /** Resolves once connected; rejects if the office refuses the connection or the client stops. */
  whenConnected(): Promise<void>;

  /**
   * Work items offered by the office. Delivery is at least once, so the same item can come again after a
   * reconnect until it is accepted; handle an id twice.
   */
  offers(): AsyncIterable<Offer>;

  /** Ids of accepted, unfinished items the office listed when the connection was last established. */
  resume(): string[];

  /**
   * Reports to requesters for the agent to post: the office hands them over each time the connection is established
   * and pushes new ones while it is up, and repeats each until `reportPosted`. The handler posts them; reports that
   * arrive before it is set wait for it.
   */
  onReports?(handler: (reports: QueuedReport[]) => void): void;

  accept(workItemId: string): Promise<void>;
  decline(workItemId: string, reason: string): Promise<void>;
  progress(workItemId: string, text: string): Promise<void>;

  /** Stores the runtime session of the item; the next offer of the item carries it. */
  session(workItemId: string, sessionId: string): Promise<void>;
  journal(workItemId: string, text: string): Promise<void>;
  handBack(
    workItemId: string,
    result: {
      summary: string;
      links?: Link[];
      status: "done" | "waiting" | "blocked" | "interrupted";
    },
  ): Promise<void>;
  fail(workItemId: string, reason: string): Promise<void>;

  /** Reports the runtime's usage windows; the office keeps the latest. */
  usage(windows: PayloadOf<"usage">["windows"]): Promise<void>;
  answer(questionId: string, answer: string): Promise<void>;
}

export interface ManualClientClock extends ClientClock {
  advance(ms: number): void;
}

/** Sends one request and resolves to the office's answer. */
export type RequestFn = <T extends MessageType>(
  type: T,
  payload: PayloadOf<T>,
  timeoutMs?: number,
) => Promise<Message>;

/** Sends one request and resolves to the payload of the expected answer; an `error` answer rejects. */
export type CallFn = <T extends MessageType, R extends MessageType>(
  type: T,
  payload: PayloadOf<T>,
  expect: R,
) => Promise<PayloadOf<R>>;

/** Sends one request the office answers with `ack`. */
export type AckFn = <T extends MessageType>(type: T, payload: PayloadOf<T>) => Promise<void>;

export interface RequestsOptions {
  clock: ClientClock;
  requestTimeoutMs: number;
  state(): ConnectionState;

  /** Whether a socket is open to send on. */
  hasSocket(): boolean;

  /** Sends a message and returns its id. */
  send<T extends MessageType>(type: T, payload: PayloadOf<T>): string;
}

/** Requests waiting for their answer, and callers waiting for the connection. */
export interface Requests {
  request: RequestFn;
  call: CallFn;
  ack: AckFn;

  /** Hands an answer to the request it replies to; false when no request waits for it. */
  settle(m: Message): boolean;
  failPending(err: Error): void;
  settleWaiters(err?: Error): void;
  whenConnected(): Promise<void>;
}

/** Offers nobody has taken yet, and the readers waiting for one. */
export interface OfferQueue {
  push(offer: Offer): void;
  end(): void;
  iterable(done: () => boolean): AsyncIterable<Offer>;
}

/** The requests a connection makes on behalf of the agent, once it is up. */
export type OfficeMethods = Omit<
  OfficeConnection,
  "start" | "stop" | "state" | "rejection" | "whenConnected" | "offers" | "resume" | "onReports"
>;
