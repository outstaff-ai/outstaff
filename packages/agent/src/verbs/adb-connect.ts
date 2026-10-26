import { PortError } from "@outstaff/core";
import { z } from "zod";
import { defineVerb, result } from "./define.js";
import {
  PAIR_TIMEOUT_MS,
  requireDevice,
  runAdb,
  knownPort,
  askForPort,
  failed,
  one,
  port,
  connect,
} from "./adb-device.js";

export const adbPair = defineVerb({
  name: "adb.pair",
  summary: "Pair with an Android device that uses wireless debugging.",
  description:
    "Pairs this agent with a granted device that has `pairing: wireless` (Android 11+ wireless debugging). A human opens Settings > Developer options > Wireless debugging > Pair device with pairing code on the device and gives you the pairing port and the six-digit code; both are valid for a short time only. The pairing key is kept in the agent's home, so pairing survives restarts. Pairing does not connect: the connect port is a different one, shown on the Wireless debugging screen; use `ost adb connect` next.",
  input: z.strictObject({
    device: z.string().min(1).max(60).describe("Name of the device, as granted to you."),
    port: port.describe("Pairing port shown on the device's pairing dialog."),
    code: z
      .string()
      .regex(/^\d{6}$/, "The pairing code is six digits.")
      .describe("Six-digit pairing code shown on the device."),
  }),
  args: ["device"],
  examples: ["ost adb pair test-tablet --port 37123 --code 123456"],
  async run(env, input) {
    const device = requireDevice(env, input.device);
    if (device.pairing !== "wireless") {
      throw new PortError(
        "invalid",
        `${device.name} is reached over adb TCP on port ${device.port} and needs no pairing; use \`ost adb connect ${device.name}\`.`,
      );
    }

    const r = await runAdb(
      env,
      ["pair", `${device.host}:${input.port}`, input.code],
      PAIR_TIMEOUT_MS,
    );

    const text = one(r).replaceAll(input.code, "******");
    if (failed(r)) {
      throw new PortError(
        "unavailable",
        `Pairing with ${device.name} failed: ${text || "no answer"}. The code and the pairing port expire quickly; ask the human to open the pairing dialog again and send the new port and code.`,
      );
    }

    return result(
      [
        `Paired with ${device.name}${text ? `: ${text}` : "."}`,
        `Next: the connect port is the one on the Wireless debugging screen (not the pairing port). Run \`ost adb connect ${device.name} --port <port>\`.`,
      ],
      { device: device.name, paired: true },
      [],
    );
  },
});

export const adbConnect = defineVerb({
  name: "adb.connect",
  summary: "Connect to a granted Android device.",
  description:
    "Connects adb to a granted device. A device with a fixed `port` (adb over TCP) needs no argument. A wireless debugging device needs the connect port a human reads off the device; the last port that worked is remembered, so after the first time you give a port only when the device stops answering (its port changes after a reboot or when wireless debugging is toggled). When the connection fails the error tells you to ask a human for the current port.",
  input: z.strictObject({
    device: z.string().min(1).max(60).describe("Name of the device, as granted to you."),
    port: port
      .optional()
      .describe(
        "Connect port from the device's Wireless debugging screen. Default: the remembered one.",
      ),
  }),
  args: ["device"],
  examples: ["ost adb connect wall-panel", "ost adb connect test-tablet --port 41555"],
  async run(env, input) {
    const device = requireDevice(env, input.device);
    if (device.port !== undefined && input.port !== undefined && input.port !== device.port) {
      throw new PortError(
        "invalid",
        `${device.name} is granted on port ${device.port}; another port cannot be used.`,
      );
    }

    const use = input.port ?? knownPort(env, device);
    if (use === undefined) {
      throw new PortError(
        "invalid",
        askForPort(device, `No connect port is known for ${device.name}.`),
      );
    }

    const serial = await connect(env, device, use);
    return result(
      [
        `Connected to ${device.name} (${serial}).`,
        `Run commands with \`ost adb run ${device.name} -- <adb args>\`.`,
      ],
      { device: device.name, serial },
      [],
    );
  },
});
