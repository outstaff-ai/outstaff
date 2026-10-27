import { describe, expect, it } from "vitest";
import { nextReadyTicket } from "../idle.js";

describe("nextReadyTicket", () => {
  it("picks the ticket that entered ready first, by time only", () => {
    const tickets = [
      { key: "ACME-9", readyAt: "2026-10-05T08:00:00.000Z" },
      { key: "ACME-10", readyAt: "2026-10-05T07:00:00.000Z" },
      { key: "ACME-2", readyAt: "2026-10-05T07:00:00.000Z" },
    ];

    expect(nextReadyTicket(tickets)?.key).toBe("ACME-10");
    expect(nextReadyTicket([])).toBeUndefined();
  });

  it("puts the tracker's priority first, then the time it entered ready, whatever the offset", () => {
    const tickets = [
      { key: "ACME-1", readyAt: "2026-10-05T06:00:00.000Z" },
      { key: "ACME-2", readyAt: "2026-10-05T09:00:00.000Z", priority: 2 },
      { key: "ACME-3", readyAt: "2026-10-05T10:00:00+02:00", priority: 2 },
      { key: "ACME-4", readyAt: "2026-10-05T11:00:00.000Z", priority: 3 },
    ];

    expect(nextReadyTicket(tickets)?.key).toBe("ACME-3");
    expect(nextReadyTicket(tickets.filter((t) => t.priority !== 2))?.key).toBe("ACME-4");
    expect(nextReadyTicket([tickets[0]!])?.key).toBe("ACME-1");
  });
});
