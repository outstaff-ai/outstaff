import { PortError, silentLogger, type Logger, type PortErrorCode } from "@outstaff/core";
import {
  PROTOCOL_VERSION,
  decode,
  encode,
  type ErrorCode,
  type Link,
  type Message,
  type MessageType,
  type PayloadOf,
} from "@outstaff/protocol";
import { WebSocket } from "ws";
import type {
  ChatMessageResult,
  ChatReportResult,
  OfficeAnswer,
  OfficeClient,
  OfficeTeam,
  OfficeTeamMember,
  OfficeWorkItem,
} from "../verbs/office.js";

export type Offer = PayloadOf<"offer">;

/** The same shape as the office's clock, so one fake serves both. */
export interface ClientClock {
  now(): Date;
  setTimeout(fn: () => void, ms: number): () => void;
}

export const systemClientClock: ClientClock = {
  now: () => new Date(),
  setTimeout(fn, ms) {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};

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

const FATAL: ErrorCode[] = ["auth_failed", "version_mismatch", "replaced"];

const PORT_CODE: Partial<Record<ErrorCode, PortErrorCode>> = {
  unknown_item: "not_found",
  not_found: "not_found",
  invalid: "invalid",
  invalid_message: "invalid",
  unsupported: "unsupported",
  auth_failed: "forbidden",
};

interface Pending {
  resolve(m: Message): void;
  reject(err: Error): void;
  cancel(): void;
}

/** Drops keys that are undefined, which the verbs' types do not allow for optional fields. */
const compact = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

const unavailable = (message: string) => new PortError("unavailable", message);

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
  // A work item and chat sessions run at once; each is kept alive by a heartbeat of its own.
  const activeItems = new Set<string>();
  let cancelBackoff: (() => void) | undefined;
  let cancelBeat: (() => void) | undefined;
  const pending = new Map<string, Pending>();
  const connectWaiters: { resolve(): void; reject(err: Error): void }[] = [];

  const offerBuffer: Offer[] = [];
  const offerWaiters: ((r: IteratorResult<Offer>) => void)[] = [];

  function pushOffer(offer: Offer) {
    // A redelivery of an offer nobody has taken yet is already in the buffer.
    if (offerBuffer.some((o) => o.workItem.id === offer.workItem.id)) {
      return;
    }

    const waiter = offerWaiters.shift();
    if (waiter) {
      waiter({ value: offer, done: false });
    } else {
      offerBuffer.push(offer);
    }
  }

  function failPending(err: Error) {
    for (const p of pending.values()) {
      p.cancel();
      p.reject(err);
    }

    pending.clear();
  }

  function settleWaiters(err?: Error) {
    for (const w of connectWaiters.splice(0)) {
      if (err) {
        w.reject(err);
      } else {
        w.resolve();
      }
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
        scheduleBeat(m.payload.heartbeatMs);
        settleWaiters();
        return;
      }

      if (m.type === "offer") {
        pushOffer(m.payload);
        return;
      }

      if (m.type === "ping") {
        rawSend("pong", {}, m.id);
        return;
      }

      if (m.replyTo !== undefined) {
        const p = pending.get(m.replyTo);
        if (p) {
          pending.delete(m.replyTo);
          p.cancel();
          p.resolve(m);
          return;
        }
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
        endOffers();
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

  function endOffers() {
    for (const w of offerWaiters.splice(0)) {
      w({ value: undefined, done: true });
    }
  }

  function request<T extends MessageType>(
    type: T,
    payload: PayloadOf<T>,
    timeoutMs = requestTimeoutMs,
  ): Promise<Message> {
    return new Promise<Message>((resolve, reject) => {
      const go = () => {
        const sock = socket;
        if (!sock || state !== "connected") {
          reject(unavailable("Not connected to the office."));
          return;
        }

        const id = rawSend(type, payload);
        const cancel = clock.setTimeout(() => {
          pending.delete(id);
          reject(unavailable(`The office did not answer ${type} in time.`));
        }, timeoutMs);

        pending.set(id, { resolve, reject, cancel });
      };

      if (state === "connected") {
        go();
        return;
      }

      if (state === "stopped" || state === "rejected" || state === "idle") {
        reject(unavailable("Not connected to the office."));
        return;
      }

      let waiting = true;
      const cancel = clock.setTimeout(() => {
        waiting = false;
        reject(unavailable("Could not reach the office in time."));
      }, timeoutMs);

      connectWaiters.push({
        resolve() {
          cancel();
          if (waiting) {
            go();
          }
        },
        reject(err) {
          cancel();
          reject(err);
        },
      });
    });
  }

  async function call<T extends MessageType, R extends MessageType>(
    type: T,
    payload: PayloadOf<T>,
    expect: R,
  ): Promise<PayloadOf<R>> {
    const m = await request(type, payload);
    if (m.type === "error") {
      throw new PortError(PORT_CODE[m.payload.code] ?? "unavailable", m.payload.message);
    }

    if (m.type !== expect) {
      throw unavailable(`The office answered ${type} with ${m.type}.`);
    }

    return m.payload as PayloadOf<R>;
  }

  const ack = async <T extends MessageType>(type: T, payload: PayloadOf<T>) => {
    await call(type, payload, "ack");
  };

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
      endOffers();
      socket?.close(1000);
      socket = undefined;
    },

    state: () => state,
    rejection: () => rejected,
    resume: () => [...resumeIds],

    whenConnected() {
      if (state === "connected") {
        return Promise.resolve();
      }

      if (state === "stopped" || state === "rejected") {
        return Promise.reject(unavailable("Not connected to the office."));
      }

      return new Promise<void>((resolve, reject) => connectWaiters.push({ resolve, reject }));
    },

    offers() {
      return {
        [Symbol.asyncIterator]: () => ({
          next(): Promise<IteratorResult<Offer>> {
            const offer = offerBuffer.shift();
            if (offer) {
              return Promise.resolve({ value: offer, done: false });
            }

            if (state === "stopped" || state === "rejected") {
              return Promise.resolve({ value: undefined, done: true });
            }

            return new Promise((resolve) => offerWaiters.push(resolve));
          },
        }),
      };
    },

    async accept(workItemId) {
      await ack("accept", { workItemId });
      activeItems.add(workItemId);
    },

    decline: (workItemId, reason) => ack("decline", { workItemId, reason }),
    progress: (workItemId, text) => ack("progress", { workItemId, text }),
    session: (workItemId, sessionId) => ack("session", { workItemId, sessionId }),
    journal: (workItemId, text) => ack("journal", { workItemId, text }),
    async handBack(workItemId, result) {
      await ack("handback", { workItemId, ...result, links: result.links ?? [] });
      activeItems.delete(workItemId);
    },

    async fail(workItemId, reason) {
      await ack("fail", { workItemId, reason });
      activeItems.delete(workItemId);
    },

    usage: (windows) => ack("usage", { windows }),
    answer: (questionId, answer) => ack("answer", { questionId, answer }),

    async place(workItemId, placement) {
      const r = await call(
        "work_place",
        {
          workItemId,
          position: placement.position,
          ...(placement.relativeTo ? { relativeTo: placement.relativeTo } : {}),
        },
        "work_move_result",
      );

      return compact(r.item) as OfficeWorkItem;
    },

    chatMessage: (m): Promise<ChatMessageResult> => call("chat_message", m, "chat_message_result"),
    chatReport: (workItemId, kind): Promise<ChatReportResult> =>
      call("chat_report", { workItemId, kind }, "chat_report_result"),
    linkTicket: (workItemId, ticket) =>
      call("work_link", { workItemId, ticket }, "work_link_result"),
    attachWork: (workItemId, request) =>
      call("work_attach", { workItemId, ...request }, "work_attach_result"),
    queueWork: (workItemId, request) =>
      call("work_queue", { workItemId, ...request }, "work_queue_result"),
    async currentWork() {
      return (await call("current_work", {}, "current_work_result")).text;
    },

    ticketPrs: (draft) => call("ticket_prs", draft, "ticket_prs_result"),
    docLink: (request) => ack("doc_link", request),

    async ask(q): Promise<OfficeAnswer> {
      const r = await call("ask", q, "ask_result");
      return {
        id: r.id,
        to: r.to,
        status: r.status,
        ...(r.answer === undefined ? {} : { answer: r.answer }),
      };
    },

    async work(q): Promise<OfficeWorkItem[]> {
      const r = await call("work_list", q, "work_list_result");
      return r.items.map((i) => compact(i) as OfficeWorkItem);
    },

    async team(): Promise<OfficeTeam> {
      const r = await call("roster", {}, "roster_result");
      return {
        members: r.members.map((m) => compact(m) as OfficeTeamMember),
        humans: r.humans ?? [],
      };
    },
  };
}
