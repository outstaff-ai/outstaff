import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { envSecretSource } from "#/ports/secrets.js";
import { createFakeAdapterRegistry } from "#/fakes/index.js";
import { AdapterRegistry, defineAdapter } from "#/ports/define.js";
import type { TeamConfig } from "#/config/types.js";
import type { DoctorCheck } from "#/ports/adapter.js";
import { configuredAdapters } from "#/doctor/adapters.js";
import { scopeChecks } from "#/doctor/scope.js";

const team = {
  team: { name: "acme" },
  people: [{ handle: "sam", name: "Sam", role: "developer" }],
  integrations: {
    tracker: { adapter: "fake" },
    knowledge: { adapter: "fake" },
    chat: { adapter: "missing" },
    runtime: { adapter: "fake" },
  },
} as unknown as TeamConfig;

const fake = createFakeAdapterRegistry();
const withDoctor = (port: "tracker" | "knowledge", doctor: () => Promise<DoctorCheck[]>) =>
  defineAdapter({
    ...fake.get(port, "fake")!,
    secrets: (scope) =>
      scope === "office" ? [{ key: "FAKE_KEY", description: "k", where: "w" }] : [],
    doctor: async (_s, ctx) => {
      ctx.warn(`${port} says hi`);
      return doctor();
    },
  });

describe("the shared doctor checks", () => {
  it("skips the runtime for the office and names adapters this build does not ship", () => {
    const { found, unknown } = configuredAdapters(team, fake, "office");
    expect(found.map((f) => f.def.port)).toEqual(["tracker", "knowledge"]);
    expect(unknown).toEqual(["chat/missing"]);
  });

  it("reports a shared answer once, a check that could not run, the notes, and scrubs secrets", async () => {
    const same = async (): Promise<DoctorCheck[]> => [
      { name: "Key works", status: "ok", detail: "key s3cret-value accepted" },
    ];

    const registry = new AdapterRegistry()
      .register(withDoctor("tracker", same))
      .register(withDoctor("knowledge", () => Promise.reject(new Error("boom"))));

    const checks = await scopeChecks({
      team,
      scope: "office",
      adapters: configuredAdapters(team, registry, "office"),
      secrets: {
        get: (k) => ({ FAKE_KEY: "s3cret-value", OUTSTAFF_AGENT_TOKEN_SAM: "tok" })[k],
        require: () => "",
      },
      dir: "/nonexistent",
      handle: "office",
      context: { fetch, now: () => new Date() },
      extra: [{ name: "Host", status: "ok", detail: "fine" }],
      fileModes: false,
    });

    expect(checks.map((c) => [c.name, c.status, c.adapter])).toEqual([
      ["OUTSTAFF_AGENT_TOKEN_SAM present", "ok", undefined],
      ["FAKE_KEY present", "ok", undefined],
      ["chat/missing not checked", "warn", undefined],
      ["Host", "ok", undefined],
      ["Key works", "ok", "fake"],
      ["fake checks", "fail", "fake"],
      ["Note", "warn", undefined],
      ["Note", "warn", undefined],
    ]);

    expect(checks.find((c) => c.name === "Key works")!.detail).toBe("key *** accepted");
    expect(checks.find((c) => c.name === "fake checks")!.detail).toBe(
      "The checks could not run: boom",
    );
  });

  it("checks secret file modes unless told the platform sets them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "core-doctor-"));
    writeFileSync(join(dir, "OUTSTAFF_AGENT_TOKEN_SAM"), "a-long-token\n");
    chmodSync(join(dir, "OUTSTAFF_AGENT_TOKEN_SAM"), 0o440);
    const run = (fileModes?: boolean) =>
      scopeChecks({
        team,
        scope: "office",
        adapters: { found: [], unknown: [] },
        secrets: envSecretSource({}, dir),
        dir,
        handle: "office",
        context: { fetch, now: () => new Date() },
        ...(fileModes === undefined ? {} : { fileModes }),
      });

    expect((await run()).map((c) => [c.name, c.status])).toEqual([
      ["OUTSTAFF_AGENT_TOKEN_SAM present", "ok"],
      ["OUTSTAFF_AGENT_TOKEN_SAM file mode", "fail"],
    ]);

    expect((await run(false)).map((c) => [c.name, c.status])).toEqual([
      ["OUTSTAFF_AGENT_TOKEN_SAM present", "ok"],
    ]);

    rmSync(dir, { recursive: true, force: true });
  });
});
