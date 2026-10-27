import { PortError, type EventPage } from "#/ports/index.js";

/** A deterministic clock that moves forward one second per call. */
export function steppingClock(start = "2030-01-01T00:00:00.000Z"): () => Date {
  let t = Date.parse(start);
  return () => new Date((t += 1000));
}

/** Append-only log; the cursor is the number of events already delivered. */
export class EventLog<E> {
  private readonly items: E[] = [];

  push(event: E): void {
    this.items.push(event);
  }

  since(cursor: string | undefined): EventPage<E> {
    const from = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isInteger(from) || from < 0 || from > this.items.length) {
      throw new PortError("invalid", `Unknown cursor "${cursor}".`);
    }

    return { events: this.items.slice(from), cursor: String(this.items.length) };
  }
}

export function fakeBaseUrl(url: string | undefined, fallback: string): string {
  return (url ?? fallback).replace(/\/+$/, "");
}
