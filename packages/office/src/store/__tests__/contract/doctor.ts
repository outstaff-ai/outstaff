import { expect, it } from "vitest";
import type { ContractContext } from "#/store/__tests__/contract.types.js";

const T1 = "2026-10-01T06:00:00.000Z";
const T2 = "2026-10-02T06:00:00.000Z";
const T3 = "2026-10-03T06:00:00.000Z";

/** The doctor checks: one row per check and scope, replaced run by run. */
export function doctorCases(ctx: ContractContext): void {
  it("keeps a check's first-seen time while its status stays, and resets it when the status changes", async () => {
    let now = new Date(T1);
    await ctx.store.close();
    await ctx.open({ now: () => now });
    expect(await ctx.store.listDoctorChecks()).toEqual([]);

    await ctx.store.recordDoctorRun("office", [
      {
        name: "OUTSTAFF_AGENT_TOKEN_SAM present",
        status: "fail",
        detail: "Missing.",
        fix: "Create it.",
        key: "OUTSTAFF_AGENT_TOKEN_SAM",
      },
      { name: "Slack token", status: "ok", detail: "Valid.", adapter: "slack" },
    ]);

    await ctx.store.recordDoctorRun("sam", [
      { name: "Tools install", status: "ok", detail: "jq@1.7" },
    ]);

    now = new Date(T2);
    await ctx.store.recordDoctorRun("office", [
      {
        name: "OUTSTAFF_AGENT_TOKEN_SAM present",
        status: "fail",
        detail: "Still missing.",
        fix: "Create it.",
        key: "OUTSTAFF_AGENT_TOKEN_SAM",
      },
      { name: "Slack token", status: "ok", detail: "Valid.", adapter: "slack" },
    ]);

    expect(await ctx.store.listDoctorChecks("office")).toEqual([
      {
        scope: "office",
        name: "OUTSTAFF_AGENT_TOKEN_SAM present",
        status: "fail",
        detail: "Still missing.",
        fix: "Create it.",
        key: "OUTSTAFF_AGENT_TOKEN_SAM",
        firstSeen: T1,
        lastSeen: T2,
      },
      {
        scope: "office",
        name: "Slack token",
        status: "ok",
        detail: "Valid.",
        adapter: "slack",
        firstSeen: T1,
        lastSeen: T2,
      },
    ]);

    now = new Date(T3);
    await ctx.store.recordDoctorRun("office", [
      {
        name: "OUTSTAFF_AGENT_TOKEN_SAM present",
        status: "ok",
        detail: "Provided.",
        key: "OUTSTAFF_AGENT_TOKEN_SAM",
      },
    ]);

    // Passed now: the fix is gone and first-seen restarts; the check the run did not report is removed.
    expect(await ctx.store.listDoctorChecks("office")).toEqual([
      {
        scope: "office",
        name: "OUTSTAFF_AGENT_TOKEN_SAM present",
        status: "ok",
        detail: "Provided.",
        key: "OUTSTAFF_AGENT_TOKEN_SAM",
        firstSeen: T3,
        lastSeen: T3,
      },
    ]);

    // Another scope's checks are its own.
    expect((await ctx.store.listDoctorChecks()).map((c) => [c.scope, c.name])).toEqual([
      ["office", "OUTSTAFF_AGENT_TOKEN_SAM present"],
      ["sam", "Tools install"],
    ]);
  });

  it("clears a scope with an empty run", async () => {
    await ctx.store.recordDoctorRun("sam", [
      { name: "Tools install", status: "fail", detail: "jq did not install." },
    ]);

    await ctx.store.recordDoctorRun("sam", []);
    expect(await ctx.store.listDoctorChecks("sam")).toEqual([]);
  });

  it("keeps the doctor checks across a reopen", async () => {
    await ctx.store.recordDoctorRun("office", [
      { name: "Slack token", status: "warn", detail: "Odd." },
    ]);

    await ctx.store.close();
    await ctx.open();
    expect((await ctx.store.listDoctorChecks()).length).toBe(ctx.h.persistent ? 1 : 0);
  });
}
