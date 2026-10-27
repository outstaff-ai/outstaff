import { execFile } from "node:child_process";
import { connect } from "node:net";
import {
  networkGrants,
  originOf,
  type AdbGrant,
  type DoctorCheck,
  type HttpGrant,
  type TeamConfig,
} from "@outstaff/core";
import { deviceCheck, rememberedPorts } from "./devices.js";
import { PROBE_TIMEOUT_MS } from "./probe.js";
import type { NetworkProbes } from "./types.js";

type Status = DoctorCheck["status"];

const tcpReachable = (host: string, port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ host, port, timeout: PROBE_TIMEOUT_MS });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });

    for (const event of ["error", "timeout"] as const) {
      socket.once(event, () => {
        socket.destroy();
        resolve(false);
      });
    }
  });

const adbRuns = (env: NodeJS.ProcessEnv): Promise<boolean> =>
  new Promise((resolve) => {
    execFile("adb", ["version"], { env, timeout: PROBE_TIMEOUT_MS }, (error) => resolve(!error));
  });

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

async function adbCheck(ctx: NetworkProbes, status: Status): Promise<DoctorCheck> {
  const ok = await (ctx.adbProbe ?? (() => adbRuns(ctx.env)))();
  return ok
    ? { name: "adb runs", status: "ok", detail: "adb is on the PATH." }
    : {
        name: "adb runs",
        status,
        detail: "adb is not installed here or does not run.",
        fix: "Declare adb under tools in team.yaml (see the network grants guide) and restart the agent, or put it on the PATH of the image.",
      };
}

async function deviceChecks(ctx: NetworkProbes, adb: AdbGrant[], status: Status) {
  if (adb.length === 0) {
    return [];
  }

  const remembered = rememberedPorts(ctx.home);
  const out = [await adbCheck(ctx, status)];
  for (const g of adb) {
    out.push(await deviceCheck(ctx.tcpProbe ?? tcpReachable, g, remembered, status));
  }

  return out;
}

/**
 * Does each HTTP service of the person answer, and each adb device accept a connection? The service is probed
 * without its token, so a 401 still counts: it answered. The network path itself (for example a Kubernetes
 * NetworkPolicy) is only visible from inside the agent container, so elsewhere a failure is a warning.
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

  return [...out, ...(await deviceChecks(ctx, grants.adb, status))];
}
