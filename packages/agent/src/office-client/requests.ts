import { PortError } from "@outstaff/core";
import type { Message, MessageType, PayloadOf } from "@outstaff/protocol";
import { PORT_CODE, unavailable } from "./errors.js";
import type { Requests, RequestsOptions } from "./types.js";

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

  function request<T extends MessageType>(
    type: T,
    payload: PayloadOf<T>,
    timeoutMs = requestTimeoutMs,
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
          reject(unavailable(`The office did not answer ${type} in time.`));
        }, timeoutMs);

        pending.set(id, { resolve, reject, cancel });
      };

      const state = opts.state();
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
