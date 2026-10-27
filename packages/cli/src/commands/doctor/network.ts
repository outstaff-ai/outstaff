import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { networkGrants, originOf, type DoctorCheck, type TeamConfig } from "@outstaff/core";
import type { Context } from "../../types.js";
import type { Status } from "./types.js";

const PROBE_TIMEOUT_MS = 5_000;

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

type Grants = ReturnType<typeof networkGrants>;
type HttpGrant = Grants["http"][number];
type AdbGrant = Grants["adb"][number];
type RememberedPorts = Record<string, { host: string; port: number }>;

const unreachableWhy = (e: unknown) =>
  (e as Error).name === "TimeoutError" ? "timed out" : "connection failed";

/** Does the service answer at all? Its token is not sent, so any status counts. */
async function serviceCheck(ctx: Context, g: HttpGrant, status: Status): Promise<DoctorCheck> {
  const origin = originOf(g.url)!;
  const name = `Service ${g.name} answers`;
  try {
    const res = await (ctx.fetch ?? fetch)(origin, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    return { name, status: "ok", detail: `${origin} answered ${res.status}.` };
  } catch (e) {
    return {
      name,
      status,
      detail: `${origin} did not answer (${unreachableWhy(e)}).`,
      fix: `Check the service is up and that the deployment allows the agent to reach ${new URL(origin).host} (for example a Kubernetes NetworkPolicy).`,
    };
  }
}

async function adbRunsCheck(ctx: Context, status: Status): Promise<DoctorCheck> {
  const adbOk = await (ctx.adbProbe ?? (() => adbRuns(ctx.env)))();
  return adbOk
    ? { name: "adb runs", status: "ok", detail: "adb is on the PATH." }
    : {
        name: "adb runs",
        status,
        detail: "adb is not installed here or does not run.",
        fix: "Declare adb under tools in team.yaml (see the network grants guide) and restart the agent, or put it on the PATH of the image.",
      };
}

/** The wireless debugging ports `ost adb connect` remembered, by device name. */
function rememberedPorts(ctx: Context): RememberedPorts {
  try {
    return JSON.parse(
      readFileSync(join(ctx.home ?? homedir(), ".outstaff", "adb-ports.json"), "utf8"),
    ) as RememberedPorts;
  } catch {
    return {};
  }
}

/** The port to probe: the configured one, or the one remembered for the same host. */
function devicePort(g: AdbGrant, remembered: RememberedPorts): number | undefined {
  const saved = remembered[g.name];
  return g.port ?? (saved?.host === g.host ? saved.port : undefined);
}

const unreachableDevice = (g: AdbGrant, port: number, status: Status): DoctorCheck => ({
  name: `Device ${g.name} reachable`,
  status: g.pairing ? "warn" : status,
  detail: `${g.host}:${port} did not accept a connection.`,
  fix: g.pairing
    ? "The wireless debugging port changes after a reboot or a toggle; a human gives the current one to `ost adb connect`. Also check the deployment allows the agent to reach the device (for example a Kubernetes NetworkPolicy)."
    : "Check the device is on with adb over TCP enabled, and that the deployment allows the agent to reach it (for example a Kubernetes NetworkPolicy).",
});

async function deviceCheck(
  ctx: Context,
  g: AdbGrant,
  port: number | undefined,
  status: Status,
): Promise<DoctorCheck> {
  const name = `Device ${g.name} reachable`;
  if (port === undefined) {
    return {
      name,
      status: "ok",
      detail: `${g.host} uses wireless debugging; no connect port is remembered yet, so it was not probed. A human gives the first port to \`ost adb connect\`.`,
    };
  }

  const up = await (ctx.tcpProbe ?? tcpReachable)(g.host, port);
  return up
    ? { name, status: "ok", detail: `${g.host}:${port} accepts connections.` }
    : unreachableDevice(g, port, status);
}

/**
 * Does each HTTP service of the person answer, and each adb device accept a connection? The service is probed
 * without its token, so a 401 still counts: it answered. The network path itself (for example a Kubernetes
 * NetworkPolicy) is only visible from inside the agent container, so elsewhere a failure is a warning.
 */
export async function networkChecks(
  ctx: Context,
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

  if (grants.adb.length === 0) {
    return out;
  }

  out.push(await adbRunsCheck(ctx, status));
  const remembered = rememberedPorts(ctx);
  for (const g of grants.adb) {
    out.push(await deviceCheck(ctx, g, devicePort(g, remembered), status));
  }

  return out;
}
