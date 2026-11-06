import { PortError, silentLogger } from "@outstaff/core";
import {
  PROTOCOL_VERSION,
  decode,
  encode,
  type ErrorCode,
  type Message,
  type MessageType,
  type PayloadOf,
  type QueuedAct,
  type QueuedReport,
} from "@outstaff/protocol";
import { WebSocket } from "ws";
import { createBeats } from "./beats.js";
import { FATAL, Unanswered, unavailable } from "./errors.js";
import { heldFor } from "./held.js";
import { officeMethods } from "./methods.js";
import { createOfferQueue } from "./offers.js";
import { createRequests } from "./requests.js";
import type {
  Team,
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

const openWebSocket = (url: string) => new WebSocket(url) as unknown as ClientSocket;

/** How long to wait before reconnecting: exponential with jitter, between half the ceiling and the ceiling. */
function backoffDelay(opts: OfficeConnectionOptions) {
  const baseMs = opts.backoff?.baseMs ?? 1_000;
  const maxMs = opts.backoff?.maxMs ?? 30_000;
  const random = opts.random ?? Math.random;

  return (attempt: number) => {
    const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
    return Math.round(ceiling / 2 + (ceiling / 2) * random());
  };
}

export function createOfficeConnection(opts: OfficeConnectionOptions): OfficeConnection {
  const clock = opts.clock ?? systemClientClock;
  const log = opts.logger ?? silentLogger;
  const open = opts.socket ?? openWebSocket;
  const delayFor = backoffDelay(opts);
  const requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;

  let state: ConnectionState = "idle";
  let socket: ClientSocket | undefined;
  let attempt = 0;
  let counter = 0;
  let rejected: { code: ErrorCode; message: string } | undefined;
  const reports = heldFor<QueuedReport>();
  const acts = heldFor<QueuedAct>();
  let team: Team | undefined;
  let teamHandler: ((team: Team) => void) | undefined;
  // A change that came before anyone listened; handed to the handler when it is set.
  let heldTeam: Team | undefined;
  // A work item and chat sessions run at once; each is kept alive by a heartbeat of its own.
  const activeItems = new Set<string>();
  let cancelBackoff: (() => void) | undefined;
  const offers = createOfferQueue();
  const { request, call, ack, settle, failPending, settleWaiters, whenConnected } = createRequests({
    clock,
    requestTimeoutMs,
    state: () => state,
    hasSocket: () => socket !== undefined,
    send: (type, payload) => rawSend(type, payload),
  });

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

  const beats = createBeats({
    clock,
    log,
    request,
    connected: () => state === "connected",
    items: () => activeItems,
    silent: () => socket?.terminate(),
  });

  /** A running item the office no longer has active was ended while the agent was away; it is not kept alive. */
  function keepResumed(resume: string[]) {
    for (const id of activeItems) {
      if (!resume.includes(id)) {
        log.warn("the office no longer has a running item active", { workItemId: id });
        activeItems.delete(id);
      }
    }
  }

  function teamChanged(next: Team) {
    if (teamHandler) {
      teamHandler(next);
    } else {
      heldTeam = next;
    }
  }

  function welcomed(welcome: PayloadOf<"welcome">) {
    attempt = 0;
    state = "connected";
    keepResumed(welcome.resume);
    if (welcome.reports?.length) {
      reports.deliver(welcome.reports);
    }

    if (welcome.acts?.length) {
      acts.deliver(welcome.acts);
    }

    beats.start(welcome.heartbeatMs);
    const previous = team;
    team = welcome.team;
    settleWaiters();
    // The office sends its team on every welcome; a reconnect after the office restarted can bring a new one.
    if (previous && JSON.stringify(previous) !== JSON.stringify(team)) {
      teamChanged(team);
    }
  }

  /** An error that answers no request: a fatal one means the office refuses this agent. */
  function officeError(error: PayloadOf<"error">) {
    if (FATAL.includes(error.code)) {
      rejected = error;
    } else {
      log.warn("error from the office", error);
    }
  }

  /** Handles a message the office sends on its own; false for anything else. */
  function pushed(m: Message): boolean {
    switch (m.type) {
      case "welcome":
        welcomed(m.payload);
        return true;
      case "offer":
        offers.push(m.payload);
        return true;
      case "reports":
        reports.deliver(m.payload.reports);
        return true;
      case "act":
        acts.deliver([m.payload]);
        return true;
      case "ping":
        rawSend("pong", {}, m.id);
        return true;
      default:
        return false;
    }
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
        running: [...activeItems],
      });
    });

    ws.on("message", (data) => {
      const decoded = decode(data.toString());
      if (!decoded.ok) {
        log.warn("unreadable message from the office", { problem: decoded.message });
        return;
      }

      const m = decoded.message;
      if (pushed(m) || settle(m)) {
        return;
      }

      if (m.type === "error") {
        officeError(m.payload);
      }
    });

    ws.on("error", (err) => log.warn("connection error", { error: err.message }));

    ws.on("close", () => {
      if (socket !== ws) {
        return;
      }

      socket = undefined;
      beats.stop();
      failPending(new Unanswered("The connection to the office was lost."));
      if (state === "stopped") {
        return;
      }

      if (rejected) {
        state = "rejected";
        settleWaiters(new PortError("forbidden", rejected.message));
        offers.end();
        return;
      }

      const delay = delayFor(attempt);
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
      beats.stop();
      failPending(unavailable("The client stopped."));
      settleWaiters(unavailable("The client stopped."));
      offers.end();
      socket?.close(1000);
      socket = undefined;
    },

    state: () => state,
    rejection: () => rejected,
    teamConfig: () => team,
    onTeamConfigChange(handler) {
      teamHandler = handler;
      if (heldTeam) {
        const held = heldTeam;
        heldTeam = undefined;
        handler(held);
      }
    },

    onReports: (handler) => reports.listen(handler),
    onActs: (handler) => acts.listen(handler),

    whenConnected,
    offers: () => offers.iterable(() => state === "stopped" || state === "rejected"),
    ...officeMethods(call, ack, activeItems),
  };
}
