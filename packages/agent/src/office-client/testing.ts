import { PROTOCOL_VERSION, encode, type Message } from "@outstaff/protocol";
import type { ClientClock, ClientSocket } from "./client.js";

export interface ManualClientClock extends ClientClock {
  advance(ms: number): void;
}

export function createManualClock(): ManualClientClock {
  let now = Date.parse("2030-01-01T00:00:00.000Z");
  let timers: { at: number; fn: () => void }[] = [];
  return {
    now: () => new Date(now),
    setTimeout(fn, ms) {
      const t = { at: now + ms, fn };
      timers.push(t);
      return () => {
        timers = timers.filter((x) => x !== t);
      };
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= target).toSorted((a, b) => a.at - b.at)[0];
        if (!due) {
          break;
        }

        timers = timers.filter((t) => t !== due);
        now = due.at;
        due.fn();
      }

      now = target;
    },
  };
}

type Listener = (...args: never[]) => void;

/** A scripted office end of the connection. */
export class FakeSocket implements ClientSocket {
  readonly sent: Message[] = [];
  closedWith: number | undefined;
  terminated = false;
  private listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  send(data: string) {
    this.sent.push(JSON.parse(data) as Message);
  }

  close(code?: number) {
    this.closedWith = code;
  }

  terminate() {
    this.terminated = true;
    this.drop(1006);
  }

  private emit(event: string, ...args: unknown[]) {
    for (const l of this.listeners.get(event) ?? []) {
      (l as (...a: unknown[]) => void)(...args);
    }
  }

  open() {
    this.emit("open");
  }

  receive(message: unknown) {
    this.emit("message", {
      toString: () => (typeof message === "string" ? message : JSON.stringify(message)),
    });
  }

  drop(code = 1006) {
    this.emit("close", code);
  }

  /** Messages the client sent of a type. */
  sentOf(type: string) {
    return this.sent.filter((m) => m.type === type);
  }

  last(): Message {
    const m = this.sent.at(-1);
    if (!m) {
      throw new Error("nothing sent");
    }

    return m;
  }

  /** Answers the hello like the office would. */
  welcome(opts: { heartbeatMs?: number; resume?: string[] } = {}) {
    const hello = this.sentOf("hello")[0];
    this.receive({
      id: "o1",
      replyTo: hello?.id,
      type: "welcome",
      payload: {
        protocolVersion: PROTOCOL_VERSION,
        heartbeatMs: opts.heartbeatMs ?? 1000,
        resume: opts.resume ?? [],
      },
    });
  }

  reply(request: Message, type: string, payload: unknown = {}) {
    this.receive({ id: `r-${request.id}`, replyTo: request.id, type, payload });
  }

  offer(id: string) {
    this.receive(
      JSON.parse(
        encode({
          id: `offer-${id}-${Math.random()}`,
          type: "offer",
          payload: {
            workItem: { id, kind: "ticket", title: `Item ${id}`, priority: 100, trigger: "human" },
            context: { journal: [], subjects: [], links: [] },
          },
        }),
      ),
    );
  }
}
