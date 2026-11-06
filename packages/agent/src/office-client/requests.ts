import { PortError } from "@outstaff/core";
import type { Message, MessageType, PayloadOf } from "@outstaff/protocol";
import { PORT_CODE, Unanswered, unavailable } from "./errors.js";
import type { CallOptions, Requests, RequestsOptions } from "./types.js";

interface Pending {
  resolve(m: Message): void;
  reject(err: Error): void;
  cancel(): void;
}

/** Matches the office's answers to the requests sent, and holds requests made while the client connects. */
export function createRequests(opts: RequestsOptions): Requests {
  const { clock, requestTimeoutMs } = opts;
  const pending = new Map<string, Pending>();
  const connectWaiters: { resolve(): void; reject(err: Error): void }[] = [];

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

  /** With `wait` false, a request made while the client is not connected fails at once instead of waiting for it. */
  function request<T extends MessageType>(
    type: T,
    payload: PayloadOf<T>,
    timeoutMs = requestTimeoutMs,
    wait = true,
  ): Promise<Message> {
    return new Promise<Message>((resolve, reject) => {
      const go = () => {
        if (!opts.hasSocket() || opts.state() !== "connected") {
          reject(unavailable("Not connected to the office."));
          return;
        }

        const id = opts.send(type, payload);
        const cancel = clock.setTimeout(() => {
          pending.delete(id);
          reject(new Unanswered(`The office did not answer ${type} in time.`));
        }, timeoutMs);

        pending.set(id, { resolve, reject, cancel });
      };

      const state = opts.state();
      if (state === "connected") {
        go();
        return;
      }

      if (!wait || state === "stopped" || state === "rejected" || state === "idle") {
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
    how: CallOptions = {},
  ): Promise<PayloadOf<R>> {
    const m = await sent(type, payload, how);
    if (m.type === "error") {
      throw new PortError(PORT_CODE[m.payload.code] ?? "unavailable", m.payload.message);
    }

    if (m.type !== expect) {
      throw unavailable(`The office answered ${type} with ${m.type}.`);
    }

    return m.payload as PayloadOf<R>;
  }

  /**
   * The request, sent once more on the next connection when the first went unanswered (`again`), or not at all when
   * the client is not connected now (`now`).
   */
  async function sent<T extends MessageType>(type: T, payload: PayloadOf<T>, how: CallOptions) {
    try {
      return await request(type, payload, requestTimeoutMs, !how.now);
    } catch (e) {
      if (!how.again || !(e instanceof Unanswered)) {
        throw e;
      }

      return request(type, payload);
    }
  }

  const ack = async <T extends MessageType>(type: T, payload: PayloadOf<T>, how?: CallOptions) => {
    await call(type, payload, "ack", how);
  };

  return {
    request,
    call,
    ack,
    settle(m) {
      if (m.replyTo === undefined) {
        return false;
      }

      const p = pending.get(m.replyTo);
      if (!p) {
        return false;
      }

      pending.delete(m.replyTo);
      p.cancel();
      p.resolve(m);
      return true;
    },

    failPending,
    settleWaiters,
    whenConnected() {
      const state = opts.state();
      if (state === "connected") {
        return Promise.resolve();
      }

      if (state === "stopped" || state === "rejected") {
        return Promise.reject(unavailable("Not connected to the office."));
      }

      return new Promise<void>((resolve, reject) => connectWaiters.push({ resolve, reject }));
    },
  };
}
