import { PROTOCOL_VERSION, encode, type Message, type PayloadOf } from "@outstaff/protocol";
import { parseYaml } from "@outstaff/core";
import { createOfficeConnection } from "#/office-client/client.js";
import type {
  ClientSocket,
  ManualClientClock,
  OfficeConnection,
  Team,
} from "#/office-client/types.js";

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

  /** Answers the hello like the office would. Without a `team`, an empty one stands in for tests that do not read it. */
  welcome(
    opts: {
      heartbeatMs?: number;
      resume?: string[];
      reports?: PayloadOf<"welcome">["reports"];
      team?: PayloadOf<"welcome">["team"];
    } = {},
  ) {
    const hello = this.sentOf("hello")[0];
    this.receive({
      id: "o1",
      replyTo: hello?.id,
      type: "welcome",
      payload: {
        protocolVersion: PROTOCOL_VERSION,
        heartbeatMs: opts.heartbeatMs ?? 1000,
        resume: opts.resume ?? [],
        team: opts.team ?? {},
        ...(opts.reports ? { reports: opts.reports } : {}),
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

/**
 * A connection to a scripted office that welcomes the agent with the team in `yaml` each time it connects, as the
 * office does. `setTeam` changes what the next welcome brings; `sockets` are the connections made so far.
 */
export function officeWithTeam(yaml: string, person = "sam") {
  let team = parseYaml(yaml).value as Team;
  const sockets: FakeSocket[] = [];
  const connect = (): OfficeConnection =>
    createOfficeConnection({
      url: "ws://office.test/agent",
      person,
      token: "t",
      agentVersion: "test",
      backoff: { baseMs: 1, maxMs: 1 },
      socket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        // After the client has put its listeners on the socket.
        queueMicrotask(() => {
          s.open();
          s.welcome({ team });
        });

        return s;
      },
    });

  return {
    connect,
    sockets,
    setTeam(next: string) {
      team = parseYaml(next).value as Team;
    },
  };
}
