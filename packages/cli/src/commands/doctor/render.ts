import type { Context } from "#/types.js";
import { plural } from "./check.js";
import type { DoctorSummary, ScopeReport, Status } from "./types.js";

const countStatus = (reports: readonly ScopeReport[], s: Status) =>
  reports.reduce((n, r) => n + r.checks.filter((c) => c.status === s).length, 0);

export const summarize = (reports: readonly ScopeReport[]): DoctorSummary => ({
  ok: countStatus(reports, "ok"),
  warn: countStatus(reports, "warn"),
  fail: countStatus(reports, "fail"),
});

export function printJson(ctx: Context, reports: ScopeReport[], summary: DoctorSummary): void {
  ctx.out(`${JSON.stringify({ ok: summary.fail === 0, summary, scopes: reports }, null, 2)}\n`);
}

function printScope(ctx: Context, report: ScopeReport): void {
  ctx.out(`${report.scope}\n`);
  for (const c of report.checks) {
    ctx.out(`  ${c.status.padEnd(4)}  ${c.name}: ${c.detail}\n`);
    if (c.fix && c.status !== "ok") {
      ctx.out(`        Fix: ${c.fix}\n`);
    }
  }

  ctx.out("\n");
}

export function printText(ctx: Context, reports: ScopeReport[], summary: DoctorSummary): void {
  for (const r of reports) {
    printScope(ctx, r);
  }

  ctx.out(
    `${summary.ok} ok, ${plural(summary.warn, "warning")}, ${plural(summary.fail, "failure")}\n`,
  );
}
