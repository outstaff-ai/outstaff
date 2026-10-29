import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeAdapterRegistry } from "@outstaff/core/fakes";
import { describe, expect, it } from "vitest";
import { createOfficeConnection } from "#/office-client/index.js";
import {
  FakeSocket,
  createManualClock,
  officeWithTeam,
} from "#/office-client/__tests__/testing.js";
import { withGlobalConfig } from "#/tools/mise-current.js";
import { createAgentRunner } from "#/runner/run.js";
import type { StartupOptions } from "#/runner/startup.types.js";

const stockCatalogDir = fileURLToPath(new URL("../../../../catalog", import.meta.url));

const TEAM = `
version: 1
team: { name: acme, product: Acme Shop }
catalog: { version: 0.0.0 }
repos:
  - { name: shop, url: github.com/acme-example/shop, kind: primary }
people:
  - { handle: sam, name: Sam Duarte, role: developer, repos: { shop: write } }
integrations:
  chat: { adapter: fake }
  vcs: { adapter: fake }
  runtime: { adapter: fake }
  tracker: { adapter: fake }
`;

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(cond: () => boolean) {
  for (let i = 0; i < 500 && !cond(); i++) {
    await tick();
  }

  expect(cond()).toBe(true);
}

/** Sam's container: only the office URL, the person and the token; no team file. */
function setup(): { home: string; options: StartupOptions } {
  const dir = mkdtempSync(join(tmpdir(), "ost-run-"));
  const home = join(dir, "home");
  return {
    home,
    options: {
      env: {
        OUTSTAFF_PERSON: "sam",
        OUTSTAFF_OFFICE_URL: "ws://office.test/agent",
        OUTSTAFF_SECRETS_DIR: join(dir, "none"),
        OUTSTAFF_AGENT_TOKEN: "tok",
      },
      home,
      registry: createFakeAdapterRegistry(),
      stockCatalogDir,
      agentVersion: "test",
      tools: {
        mise: withGlobalConfig(async () => ({ code: 0, stdout: "", stderr: "" })),
        addToPath: () => {},
      },
    },
  };
}

describe("agent runner", () => {
  it("renders from the office's team, and again from a changed one after the office restarts", async () => {
    const { home, options } = setup();
    const office = officeWithTeam(TEAM);
    const runner = createAgentRunner(options, office.connect);
    const running = runner.run();
    const teamDoc = join(home, "work", "references", "team.md");
    await until(() => existsSync(teamDoc));
    expect(readFileSync(teamDoc, "utf8")).toContain("acme");
    expect(readFileSync(teamDoc, "utf8")).not.toContain("acme-next");

    // The office restarts with a changed team file: the agent reconnects, sees the new team and prepares again.
    office.setTeam(TEAM.replace("name: acme,", "name: acme-next,"));
    office.sockets[0]!.drop();
    await until(() => office.sockets.length === 3);
    await until(() => readFileSync(teamDoc, "utf8").includes("acme-next"));
    expect(office.sockets[0]!.closedWith).toBeUndefined();
    expect(office.sockets[1]!.closedWith).toBe(1000);

    runner.stop("SIGTERM");
    runner.stop("SIGTERM");
    expect(await running).toBe(0);
    expect(office.sockets[2]!.closedWith).toBe(1000);
  });

  it("sweeps once prepared, sweeps again after a team change and stops sweeping with the agent", async () => {
    const { home, options } = setup();
    mkdirSync(join(home, "scratch", "ACME-12"), { recursive: true });
    const clock = createManualClock();
    const office = officeWithTeam(TEAM);
    const asked: string[][] = [];
    const connect = () => {
      const connection = office.connect();
      connection.workStatus = async (ids) => {
        asked.push(ids);
        return ids.map((workItemId) => ({ workItemId, state: "blocked" as const }));
      };

      return connection;
    };

    const runner = createAgentRunner({ ...options, clock, sweepEveryMs: 1000 }, connect);
    const running = runner.run();
    await until(() => asked.length === 1);
    expect(asked[0]).toEqual(["ACME-12"]);

    // A changed team: the old round's sweeper stops and the new round starts its own.
    office.setTeam(TEAM.replace("name: acme,", "name: acme-next,"));
    office.sockets[0]!.drop();
    await until(() => asked.length === 2);
    clock.advance(1000);
    await until(() => asked.length === 3);
    await tick();
    expect(asked).toHaveLength(3);

    runner.stop("SIGTERM");
    expect(await running).toBe(0);
    clock.advance(1000);
    await tick();
    expect(asked).toHaveLength(3);
  });

  it("stops cleanly while it still waits for the office", async () => {
    const { options } = setup();
    const socket = new FakeSocket();
    const runner = createAgentRunner(options, () =>
      createOfficeConnection({
        url: "ws://office.test/agent",
        person: "sam",
        token: "t",
        agentVersion: "test",
        socket: () => socket,
      }),
    );

    const running = runner.run();
    await tick();
    runner.stop("SIGINT");
    expect(await running).toBe(0);
  });

  it("ends with 1 when the office refuses the agent while it works", async () => {
    const { home, options } = setup();
    const office = officeWithTeam(TEAM);
    const runner = createAgentRunner(options, office.connect);
    const running = runner.run();
    await until(() => existsSync(join(home, "work", "references", "team.md")));
    await until(() => office.sockets[0]!.sentOf("doctor_report").length === 1);

    office.sockets[0]!.receive({
      id: "e1",
      type: "error",
      payload: { code: "replaced", message: "Another connection for this person took over." },
    });

    office.sockets[0]!.drop(4409);
    expect(await running).toBe(1);
  });

  it("fails to start when the team from the office does not validate", async () => {
    const { options } = setup();
    const runner = createAgentRunner(options, officeWithTeam("version: 2\n").connect);
    await expect(runner.run()).rejects.toThrow(/The team config from the office is invalid:\n/);
  });
});
