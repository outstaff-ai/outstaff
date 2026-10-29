import {
  networkGrants,
  originOf,
  type DoctorCheck,
  type HttpGrant,
  type TeamConfig,
} from "@outstaff/core";
import { PROBE_TIMEOUT_MS } from "./probe.js";
import type { NetworkProbes } from "./types.js";

type Status = DoctorCheck["status"];

async function serviceCheck(
  ctx: NetworkProbes,
  g: HttpGrant,
  status: Status,
): Promise<DoctorCheck> {
  const origin = originOf(g.url)!;
  try {
    const res = await (ctx.fetch ?? fetch)(origin, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    return {
      name: `Service ${g.name} answers`,
      status: "ok",
      detail: `${origin} answered ${res.status}.`,
    };
  } catch (e) {
    const why = (e as Error).name === "TimeoutError" ? "timed out" : "connection failed";
    return {
      name: `Service ${g.name} answers`,
      status,
      detail: `${origin} did not answer (${why}).`,
      fix: `Check the service is up and that the deployment allows the agent to reach ${new URL(origin).host} (for example a Kubernetes NetworkPolicy).`,
    };
  }
}

/**
 * Does each HTTP service of the person answer? The service is probed without its token, so a 401 still counts: it
 * answered. The network path itself (for example a Kubernetes NetworkPolicy) is only visible from inside the agent
 * container, so elsewhere a failure is a warning.
 */
export async function networkChecks(
  ctx: NetworkProbes,
  team: TeamConfig,
  person: TeamConfig["people"][number],
  inContainer: boolean,
): Promise<DoctorCheck[]> {
  const grants = networkGrants(team, person);
  const status: Status = inContainer ? "fail" : "warn";
  const out: DoctorCheck[] = [];
  for (const g of grants.http) {
    out.push(await serviceCheck(ctx, g, status));
  }

  return out;
}
