import { describe, expect, it } from "vitest";
import {
  PRIORITY,
  compareQueue,
  isLoopGuarded,
  backoffMs,
  loopGuardVerdict,
  orderQueue,
  peakWindow,
  planMove,
  priorityFor,
  staleVerdict,
  trailingStale,
  usageVerdict,
} from "./policy.js";

const th = { defer_scheduled_at: 0.85, pause_automatic_at: 0.95 };
const q = (
  id: string,
  priority: number,
  position: number,
  createdAt = "2030-01-01T00:00:00.000Z",
) => ({
  id,
  priority,
  position,
  createdAt,
});

describe("priorityFor", () => {
  it("ranks chat < human < agent < automation < schedule", () => {
    expect(priorityFor("human", "chat")).toBe(PRIORITY.humanChat);
    expect(priorityFor("human", "assignment")).toBe(PRIORITY.human);
    expect(priorityFor("agent", "chat")).toBe(PRIORITY.agent);
    expect(priorityFor("automation", "ci")).toBe(PRIORITY.automation);
    expect(priorityFor("schedule", "job")).toBe(PRIORITY.schedule);
    const order = [
      PRIORITY.humanChat,
      PRIORITY.human,
      PRIORITY.agent,
      PRIORITY.automation,
      PRIORITY.schedule,
    ];

    expect(order).toEqual(order.toSorted((a, b) => a - b));
  });
});

describe("queue ordering", () => {
  it("sorts by priority, then position, then age, then id", () => {
    const items = [
      q("e", 50, 1, "2030-01-01T00:00:03.000Z"),
      q("d", 50, 1, "2030-01-01T00:00:02.000Z"),
      q("c", 50, 0),
      q("b", 10, 9),
      q("a", 0, 9),
    ];

    expect(orderQueue(items).map((i) => i.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("breaks a full tie by id and does not mutate its input", () => {
    const items = [q("y", 1, 1), q("x", 1, 1)];
    expect(orderQueue(items).map((i) => i.id)).toEqual(["x", "y"]);
    expect(items.map((i) => i.id)).toEqual(["y", "x"]);
    expect(compareQueue(items[0]!, items[0]!)).toBe(0);
  });
});

describe("planMove", () => {
  const queue = [q("a", 50, 1), q("b", 50, 2), q("c", 50, 3), q("d", 80, 4)];
  const ids = (plan: ReturnType<typeof planMove>) => plan.map((p) => p.id);

  it("moves before and after an anchor and renumbers", () => {
    const before = planMove(queue, "c", { before: "a" });
    expect(ids(before)).toEqual(["c", "a", "b", "d"]);
    expect(before.map((p) => p.position)).toEqual([1, 2, 3, 4]);
    expect(ids(planMove(queue, "a", { after: "b" }))).toEqual(["b", "a", "c", "d"]);
    expect(ids(planMove(queue, "a", { after: "c" }))).toEqual(["b", "c", "a", "d"]);
  });

  it("moves to last, taking the lowest class when needed", () => {
    const plan = planMove(queue, "a", { last: true });
    expect(ids(plan)).toEqual(["b", "c", "d", "a"]);
    expect(plan.find((p) => p.id === "a")?.priority).toBe(80);
  });

  it("raises the class of an item moved ahead of a more urgent one", () => {
    const plan = planMove(queue, "d", { before: "a" });
    expect(ids(plan)).toEqual(["d", "a", "b", "c"]);
    expect(plan.find((p) => p.id === "d")?.priority).toBe(50);
  });

  it("keeps the class when the move already respects it", () => {
    const plan = planMove(queue, "a", { before: "c" });
    expect(plan.every((p, i) => p.priority === queue.map((x) => x.priority)[i])).toBe(true);
  });

  it("keeps the queue sorted by priority", () => {
    const mixed = [q("a", 0, 1), q("b", 50, 2), q("c", 80, 3)];
    for (const target of [{ before: "a" }, { after: "c" }, { last: true as const }]) {
      for (const id of ["a", "b", "c"]) {
        if (
          ("before" in target && target.before === id) ||
          ("after" in target && target.after === id)
        ) {
          continue;
        }

        const plan = planMove(mixed, id, target);
        const prios = plan.map((p) => p.priority);
        expect(prios).toEqual(prios.toSorted((x, y) => x - y));
      }
    }
  });

  it("is a no-op for an item that is already there", () => {
    expect(ids(planMove(queue, "b", { after: "a" }))).toEqual(["a", "b", "c", "d"]);
    expect(ids(planMove([q("a", 1, 1)], "a", { last: true }))).toEqual(["a"]);
  });

  it("rejects unknown and self anchors", () => {
    expect(() => planMove(queue, "zz", { last: true })).toThrow(/not queued/);
    expect(() => planMove(queue, "a", { before: "zz" })).toThrow(/same queue/);
    expect(() => planMove(queue, "a", { after: "a" })).toThrow(/itself/);
  });
});

describe("loop guard", () => {
  it("limits only agent and automation triggers", () => {
    expect(isLoopGuarded("agent")).toBe(true);
    expect(isLoopGuarded("automation")).toBe(true);
    expect(isLoopGuarded("human")).toBe(false);
    expect(isLoopGuarded("schedule")).toBe(false);
  });

  it("trips at the limit, not before", () => {
    expect(loopGuardVerdict("agent", 11, 12).tripped).toBe(false);
    const v = loopGuardVerdict("agent", 12, 12);
    expect(v.tripped).toBe(true);
    expect(v.reason).toMatch(/12 agent-triggered runs/);
    expect(loopGuardVerdict("automation", 99, 12).tripped).toBe(true);
  });

  it("never trips for humans or schedules", () => {
    expect(loopGuardVerdict("human", 1000, 1).tripped).toBe(false);
    expect(loopGuardVerdict("schedule", 1000, 1).tripped).toBe(false);
  });
});

describe("usage verdict", () => {
  const w = (utilization: number, name = "5h") => ({ name, utilization });

  it("allows everything below the thresholds and without data", () => {
    for (const t of ["human", "agent", "automation", "schedule"] as const) {
      expect(usageVerdict(t, [w(0.5), w(0.1, "7d")], th)).toBeNull();
      expect(usageVerdict(t, [], th)).toBeNull();
    }
  });

  it("defers only scheduled work at the defer threshold", () => {
    expect(usageVerdict("schedule", [w(0.85)], th)?.code).toBe("usage_defer");
    expect(usageVerdict("schedule", [w(0.849)], th)).toBeNull();
    expect(usageVerdict("agent", [w(0.9)], th)).toBeNull();
    expect(usageVerdict("automation", [w(0.9)], th)).toBeNull();
    expect(usageVerdict("human", [w(0.9)], th)).toBeNull();
  });

  it("pauses all automatic work at the pause threshold", () => {
    for (const t of ["agent", "automation", "schedule"] as const) {
      expect(usageVerdict(t, [w(0.95)], th)?.code).toBe("usage_pause");
    }
  });

  it("always answers humans", () => {
    expect(usageVerdict("human", [w(1), w(1, "7d")], th)).toBeNull();
  });

  it("uses the busiest window and names it", () => {
    const v = usageVerdict("agent", [w(0.2), w(0.97, "7d")], th);
    expect(v?.code).toBe("usage_pause");
    expect(v?.reason).toMatch(/97% of the 7d limit/);
    expect(peakWindow([w(0.2), w(0.7, "7d")])?.name).toBe("7d");
    expect(peakWindow([])).toBeUndefined();
  });

  it("handles equal thresholds as pause", () => {
    const eq = { defer_scheduled_at: 0.9, pause_automatic_at: 0.9 };
    expect(usageVerdict("schedule", [w(0.9)], eq)?.code).toBe("usage_pause");
  });
});

describe("stale verdict", () => {
  const now = new Date("2030-01-01T00:20:00.000Z");
  const base = { now, staleMs: 10 * 60_000, trailingStaleRuns: 0 };

  it("is ok within the window", () => {
    expect(staleVerdict({ ...base, lastActivity: new Date("2030-01-01T00:10:01.000Z") })).toBe(
      "ok",
    );
  });

  it("retries once, then blocks", () => {
    const lastActivity = new Date("2030-01-01T00:10:00.000Z");
    expect(staleVerdict({ ...base, lastActivity })).toBe("retry");
    expect(staleVerdict({ ...base, lastActivity, trailingStaleRuns: 1 })).toBe("block");
  });

  it("counts trailing stale runs, ignoring the open run", () => {
    expect(trailingStale([])).toBe(0);
    expect(trailingStale([null])).toBe(0);
    expect(trailingStale(["stale", null])).toBe(1);
    expect(trailingStale(["stale", "ok", null])).toBe(0);
    expect(trailingStale(["ok", "stale", "stale"])).toBe(2);
    expect(trailingStale(["stale", "ok"])).toBe(0);
  });
});

describe("backoffMs", () => {
  it("doubles from the base and stops at the cap", () => {
    const retry = { base_minutes: 1, cap_minutes: 30 };
    expect([1, 2, 3, 4, 5, 6, 7, 20].map((n) => backoffMs(n, retry) / 60_000)).toEqual([
      1, 2, 4, 8, 16, 30, 30, 30,
    ]);
  });
});
