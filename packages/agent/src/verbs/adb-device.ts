import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PortError, maskSecrets, type AdbGrant } from "@outstaff/core";
import { z } from "zod";
import type { AgentEnv } from "./types.js";

const MAX_OUTPUT = 200_000;
const CONNECT_TIMEOUT_MS = 20_000;
export const PAIR_TIMEOUT_MS = 30_000;

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function requireDevice(env: AgentEnv, name: string): AdbGrant {
  const granted = env.network?.adb ?? [];
  const found = granted.find((g) => g.name === name);
  if (!found) {
    throw new PortError(
      "forbidden",
      granted.length === 0
        ? `No device is granted to ${env.person}. Ask a human to add one under network.adb.`
        : `"${name}" is not a device granted to ${env.person}. Granted: ${granted.map((g) => g.name).join(", ")}.`,
    );
  }

  return found;
}

function home(env: AgentEnv): string {
  if (!env.layout) {
    throw new PortError(
      "unavailable",
      "adb needs the agent's home directory, which is not known here.",
    );
  }

  return env.layout.home;
}

/** Only what adb needs: not the agent's other environment. */
function adbEnv(env: AgentEnv): NodeJS.ProcessEnv {
  const keep = Object.entries(process.env).filter(
    ([k]) => k === "PATH" || k === "TMPDIR" || k.startsWith("ADB_"),
  );

  return { ...Object.fromEntries(keep), HOME: home(env) };
}

export function runAdb(env: AgentEnv, args: string[], timeoutMs: number): Promise<Ran> {
  const bin = env.network?.adbCommand ?? "adb";
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        // adb keeps its keys in ~/.android, so HOME is the agent's home, which survives restarts.
        env: adbEnv(env),
        timeout: timeoutMs,
        maxBuffer: 20_000_000,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(
            new PortError(
              "unavailable",
              "adb is not installed in this agent. A human adds it to the team's tools (see the network grants guide).",
            ),
          );

          return;
        }

        const code = error ? ((error as { code?: unknown }).code as number | string) : 0;
        resolve({
          code: typeof code === "number" ? code : error ? null : 0,
          stdout,
          stderr,
          timedOut: error?.killed === true,
        });
      },
    );
  });
}

const statePath = (env: AgentEnv) => join(home(env), ".outstaff", "adb-ports.json");

type Remembered = Record<string, { host: string; port: number }>;

function readPorts(env: AgentEnv): Remembered {
  try {
    const parsed = JSON.parse(readFileSync(statePath(env), "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Remembered) : {};
  } catch {
    return {};
  }
}

function rememberPort(env: AgentEnv, device: AdbGrant, port: number): void {
  const next = { ...readPorts(env), [device.name]: { host: device.host, port } };
  const file = statePath(env);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** The port to connect to: the fixed one of a classic device, else the last connect port that worked. */
export function knownPort(env: AgentEnv, device: AdbGrant): number | undefined {
  if (device.port !== undefined) {
    return device.port;
  }

  const saved = readPorts(env)[device.name];
  return saved && saved.host === device.host ? saved.port : undefined;
}

export const askForPort = (device: AdbGrant, why: string) =>
  `${why} Ask a human for the current port: on the device open Settings > Developer options > Wireless debugging and read "IP address & Port" (the port changes after a reboot or when wireless debugging is switched off and on). Then run \`ost adb connect ${device.name} --port <port>\`. If the device says it is not paired, the human also gives the pairing port and code (\`ost adb pair ${device.name} --port <port> --code <code>\`).`;

export const failed = (r: Ran) =>
  r.code !== 0 ||
  r.timedOut ||
  /^(failed|error)\b|cannot connect|unable to connect|failed to connect/im.test(
    r.stdout + r.stderr,
  );

export const clip = (text: string) =>
  text.length > MAX_OUTPUT
    ? `${text.slice(0, MAX_OUTPUT)}\n(output cut at ${MAX_OUTPUT} characters)`
    : text;

export const one = (r: Ran) => maskSecrets(`${r.stdout}${r.stderr}`.trim());

export const port = z.number().int().min(1).max(65535);

/** Runs `adb connect` and remembers the port of a wireless device once it answers. Returns the serial. */
export async function connect(env: AgentEnv, device: AdbGrant, use: number): Promise<string> {
  const serial = `${device.host}:${use}`;
  const r = await runAdb(env, ["connect", serial], CONNECT_TIMEOUT_MS);
  if (failed(r)) {
    const detail = one(r);
    throw new PortError(
      "unavailable",
      device.pairing === "wireless"
        ? askForPort(
            device,
            `${device.name} did not answer on ${serial}${detail ? ` (${detail})` : ""}.`,
          )
        : `${device.name} did not answer on ${serial}${detail ? ` (${detail})` : ""}. Check that the device is on and adb over TCP is enabled; if it is, the network path from this agent may be closed; tell a human.`,
    );
  }

  if (device.pairing === "wireless") {
    rememberPort(env, device, use);
  }

  return serial;
}
