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
});
