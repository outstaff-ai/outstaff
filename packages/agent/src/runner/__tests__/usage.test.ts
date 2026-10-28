import type { UsageEvent } from "@outstaff/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createManualClock } from "#/office-client/__tests__/testing.js";
import type { ManualClientClock } from "#/office-client/types.js";
import { createUsageReporter } from "#/runner/usage.js";
import type { UsageReporter } from "#/runner/types.js";

const event = (utilization: number): UsageEvent => ({
  type: "usage",
  windows: [{ name: "five_hour", utilization }],
});

const MINUTE = 60_000;
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("usage reporter", () => {
  let clock: ManualClientClock;
  let sent: number[];
  let probes: number;
  let reporter: UsageReporter;

  const make = (probe: boolean = true) => {
    reporter = createUsageReporter({
      send: async (windows) => void sent.push(windows[0]!.utilization),
      runtime: probe
        ? {
            probeUsage: async () => {
              probes++;
              return event(0.5);
            },
          }
        : {},
      clock,
    });
  };

  beforeEach(() => {
    clock = createManualClock();
    sent = [];
    probes = 0;
  });

  it("sends at most one report a minute", () => {
    make();
    reporter.observe(event(0.1));
    reporter.observe(event(0.2));
    clock.advance(30_000);
    reporter.observe(event(0.3));
    expect(sent).toEqual([0.1]);

    clock.advance(MINUTE);
    reporter.observe(event(0.4));
    expect(sent).toEqual([0.1, 0.4]);
  });

  it("sends at once when a threshold is crossed in either direction", () => {
    make();
    reporter.observe(event(0.1));
    reporter.observe(event(0.86));
    reporter.observe(event(0.87));
    reporter.observe(event(0.96));
    reporter.observe(event(0.2));
    expect(sent).toEqual([0.1, 0.86, 0.96, 0.2]);
  });

  it("flushes the newest held report", () => {
    make();
    reporter.observe(event(0.1));
    reporter.observe(event(0.2));
    reporter.observe(event(0.3));
    reporter.flush();
    reporter.flush();
    expect(sent).toEqual([0.1, 0.3]);
  });

  it("does not stop on a failed send", async () => {
    let fail = true;
    const seen: number[] = [];
    const r = createUsageReporter({
      send: async (w) => {
        if (fail) {
          throw new Error("offline");
        }

        seen.push(w[0]!.utilization);
      },
      clock,
    });

    r.observe(event(0.1));
    await tick();
    fail = false;
    clock.advance(MINUTE);
    r.observe(event(0.2));
    expect(seen).toEqual([0.2]);
  });

  it("probes when started and every 10 minutes while idle", async () => {
    make();
    reporter.start();
    await tick();
    expect(probes).toBe(1);
    expect(sent).toEqual([0.5]);

    clock.advance(9 * MINUTE);
    await tick();
    expect(probes).toBe(1);

    clock.advance(MINUTE);
    await tick();
    expect(probes).toBe(2);

    reporter.setBusy(true);
    clock.advance(10 * MINUTE);
    await tick();
    expect(probes).toBe(2);

    reporter.setBusy(false);
    clock.advance(10 * MINUTE);
    await tick();
    expect(probes).toBe(3);

    reporter.stop();
    clock.advance(30 * MINUTE);
    await tick();
    expect(probes).toBe(3);
  });

  it("does nothing while idle when the runtime cannot probe", async () => {
    make(false);
    reporter.start();
    clock.advance(30 * MINUTE);
    await tick();
    expect(sent).toEqual([]);
    reporter.stop();
  });
});
