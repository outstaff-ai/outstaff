import { healthSchema, type LinkHealth } from "@outstaff/protocol";
import type { Context } from "#/types.js";
import { plural } from "./check.js";
import { officeHealthBase } from "./office.js";

const RUN_TIMEOUT_MS = 120_000;
const HEALTH_HINT =
  "Set OUTSTAFF_OFFICE_HEALTH_URL to the office's health address, for example http://office:8081.";

/** Where the running office answers `/doctor`, or why that is not known. */
function doctorUrl(env: Context["env"]): { url: string } | { problem: string } {
  const office = env["OUTSTAFF_OFFICE_URL"] ?? "";
  if (!env["OUTSTAFF_OFFICE_HEALTH_URL"] && !office) {
    return {
      problem: HEALTH_HINT,
    };
  }

  try {
    return { url: `${officeHealthBase(env, office)}/doctor` };
  } catch {
    return { problem: `OUTSTAFF_OFFICE_URL "${office}" is not a URL.` };
  }
}

async function ask(ctx: Context, url: string): Promise<LinkHealth | string> {
  try {
    const res = await (ctx.fetch ?? fetch)(url, {
      method: "POST",
      signal: AbortSignal.timeout(ctx.officeTimeoutMs ?? RUN_TIMEOUT_MS),
    });

    const parsed = healthSchema.safeParse(res.ok ? await res.json() : undefined);
    const hint = res.status === 404 ? ` ${HEALTH_HINT}` : "";
    return parsed.success
      ? parsed.data
      : `${url} answered ${res.status} without the checks.${hint}`;
  } catch (e) {
    return `${url} did not answer (${(e as Error).message}).`;
  }
}

function print(ctx: Context, health: LinkHealth) {
  for (const scope of new Set(health.checks.map((c) => c.scope))) {
    ctx.out(`${scope}\n`);
    for (const c of health.checks.filter((c) => c.scope === scope)) {
      ctx.out(`  ${c.status.padEnd(4)}  ${c.name}: ${c.detail} (since ${c.firstSeen})\n`);
      if (c.fix && c.status !== "ok") {
        ctx.out(`        Fix: ${c.fix}\n`);
      }
    }

    ctx.out("\n");
  }

  const { ok, warn, fail } = health.summary;
  ctx.out(`${ok} ok, ${plural(warn, "warning")}, ${plural(fail, "failure")}\n`);
}

/**
 * `ost doctor --via-office`: the running office runs its own checks now and answers with every stored check,
 * including the ones each agent reported when it started. `target` keeps one scope.
 */
export async function doctorViaOffice(
  ctx: Context,
  json: boolean | undefined,
  target: string | undefined,
): Promise<number> {
  const where = doctorUrl(ctx.env);
  const answer = "url" in where ? await ask(ctx, where.url) : where.problem;
  if (typeof answer === "string") {
    ctx.err(`${answer}\n`);
    return 1;
  }

  const checks = answer.checks.filter((c) => !target || c.scope === target);
  const count = (s: string) => checks.filter((c) => c.status === s).length;
  const health = {
    ...answer,
    checks,
    summary: { ok: count("ok"), warn: count("warn"), fail: count("fail") },
  };

  if (json) {
    ctx.out(`${JSON.stringify(health, null, 2)}\n`);
  } else {
    print(ctx, health);
  }

  return health.summary.fail === 0 ? 0 : 1;
}
