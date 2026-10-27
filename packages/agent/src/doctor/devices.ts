import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AdbGrant, DoctorCheck } from "@outstaff/core";

type Remembered = Record<string, { host: string; port: number }>;

/** The wireless debugging ports `ost adb connect` remembered, by device name. */
export function rememberedPorts(home: string | undefined): Remembered {
  try {
    return JSON.parse(
      readFileSync(join(home ?? homedir(), ".outstaff", "adb-ports.json"), "utf8"),
    ) as Remembered;
  } catch {
    return {};
  }
}

const unreachable = (g: AdbGrant, port: number, status: DoctorCheck["status"]): DoctorCheck => ({
  name: `Device ${g.name} reachable`,
  status: g.pairing ? "warn" : status,
  detail: `${g.host}:${port} did not accept a connection.`,
  fix: g.pairing
    ? "The wireless debugging port changes after a reboot or a toggle; a human gives the current one to `ost adb connect`. Also check the deployment allows the agent to reach the device (for example a Kubernetes NetworkPolicy)."
    : "Check the device is on with adb over TCP enabled, and that the deployment allows the agent to reach it (for example a Kubernetes NetworkPolicy).",
});

/** Does the device accept a connection on its fixed port, or on the wireless port remembered for it? */
export async function deviceCheck(
  probe: (host: string, port: number) => Promise<boolean>,
  g: AdbGrant,
  remembered: Remembered,
  status: DoctorCheck["status"],
): Promise<DoctorCheck> {
  const saved = remembered[g.name];
  const port = g.port ?? (saved?.host === g.host ? saved.port : undefined);
  if (port === undefined) {
    return {
      name: `Device ${g.name} reachable`,
      status: "ok",
      detail: `${g.host} uses wireless debugging; no connect port is remembered yet, so it was not probed. A human gives the first port to \`ost adb connect\`.`,
    };
  }

  return (await probe(g.host, port))
    ? {
        name: `Device ${g.name} reachable`,
        status: "ok",
        detail: `${g.host}:${port} accepts connections.`,
      }
    : unreachable(g, port, status);
}
