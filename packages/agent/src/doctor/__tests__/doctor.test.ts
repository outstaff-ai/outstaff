import { tmpdir } from "node:os";
import { silentLogger, type Logger, type TeamConfig } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { diskCheck, volumeUsage } from "#/doctor/disk.js";
import { reportAgentChecks, reportStartupChecks, startupChecks } from "#/doctor/startup.js";
import { toolStatusChecks } from "#/doctor/tools.js";

const GIB = 1024 ** 3;
const volume = (used: number) => async () => ({ used: used * GIB, total: 100 * GIB });

const sam = { handle: "sam", name: "Sam", role: "developer" } as TeamConfig["people"][number];
const team = { people: [sam] } as unknown as TeamConfig;

describe("the agent's startup checks", () => {
  it("reports each tool that did not install, or that all did", () => {
    expect(toolStatusChecks([])).toEqual([]);
    expect(
      toolStatusChecks([
        { name: "jq", version: "1.7.1", state: "installed" },
        { name: "node", version: "24", state: "cached" },
      ]),
    ).toEqual([{ name: "Tools install", status: "ok", detail: "jq@1.7.1, node@24 installed." }]);

    expect(
      toolStatusChecks([
        { name: "jq", version: "9", state: "unavailable", error: "jq@9 does not exist." },
        { name: "yq", version: "4", state: "unavailable" },
      ]),
    ).toEqual([
      expect.objectContaining({
        name: "Tool jq installs",
        status: "fail",
        detail: "jq@9 does not exist.",
      }),
      expect.objectContaining({
        name: "Tool yq installs",
        status: "fail",
        detail: "yq@4 did not install.",
      }),
    ]);
  });

  it("warns from 80% of the home volume used and fails from 90%", async () => {
    expect(await diskCheck("/home/agent", volume(79))).toEqual({
      name: "Home volume space",
      status: "ok",
      detail: "/home/agent: 79.0 GiB of 100.0 GiB used (79%).",
    });

    expect(await diskCheck("/home/agent", volume(80))).toMatchObject({
      status: "warn",
      fix: "Free space or grow the volume.",
    });

    expect(await diskCheck("/home/agent", volume(90))).toMatchObject({
      status: "fail",
      detail: "/home/agent: 90.0 GiB of 100.0 GiB used (90%).",
      fix: "Free space or grow the volume.",
    });

    expect(await diskCheck("/x", async () => ({ used: 0, total: 0 }))).toMatchObject({
      status: "ok",
    });

    expect(await diskCheck("/x", () => Promise.reject(new Error("ENOENT")))).toEqual({
      name: "Home volume space",
      status: "warn",
      detail: "The usage of /x could not be read: ENOENT",
    });
  });

  it("reads a real volume", async () => {
    const usage = await volumeUsage(tmpdir());
    expect(usage.total).toBeGreaterThan(0);
    expect(usage.used).toBeLessThanOrEqual(usage.total);
  });

  it("runs the tool, network and disk checks and reports them, logging what is not ok", async () => {
    const input = {
      env: {},
      home: "/home/agent",
      team,
      person: { ...sam, network: { http: [{ name: "hub", url: "http://hub.acme.example" }] } },
      tools: [{ name: "jq", version: "9", state: "unavailable" as const }],
      fetch: () => Promise.reject(new Error("refused")),
      volume: volume(10),
    };

    expect((await startupChecks(input)).map((c) => [c.name, c.status])).toEqual([
      ["Tool jq installs", "fail"],
      ["Service hub answers", "fail"],
      ["Home volume space", "ok"],
    ]);

    const warned: string[] = [];
    const log = { ...silentLogger, warn: (m: string) => void warned.push(m) } as Logger;
    const sent: unknown[] = [];
    await reportStartupChecks(input, async (checks) => void sent.push(checks), log);
    expect(sent).toHaveLength(1);
    expect(warned).toEqual(["doctor: Tool jq installs", "doctor: Service hub answers"]);

    await reportStartupChecks(input, () => Promise.reject(new Error("offline")), log);
    expect(warned.at(-1)).toBe("could not report the startup checks to the office");
    await reportStartupChecks({ ...input, tools: [] }, () => Promise.reject("down"));
  });

  it("reports a prepared agent's checks over its connection", async () => {
    const sent: unknown[] = [];
    await reportAgentChecks(
      {
        team,
        person: "sam",
        tools: [{ name: "jq", version: "1.7.1", state: "installed" }],
        connection: { doctorReport: async (checks: unknown) => void sent.push(checks) } as never,
      },
      {},
      tmpdir(),
    );

    expect(sent).toEqual([
      expect.arrayContaining([expect.objectContaining({ name: "Tools install", status: "ok" })]),
    ]);
  });
});
