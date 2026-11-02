// Assertions live in the `refused` helper.
/* oxlint-disable vitest/expect-expect */
import { createFakeVcs } from "@outstaff/core/fakes";
import { PortError, silentLogger } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { teamConfig } from "#/intake/__tests__/test-support.js";
import { officeCiLogs } from "#/office-ci-log.js";
import { ProtocolError } from "#/protocol/index.js";

const REPO = { host: "git.acme.example", owner: "acme", name: "app" };

async function setup() {
  const vcs = createFakeVcs();
  await vcs.seed.check(REPO, "abc", {
    name: "deploy",
    status: "failure",
    log: {
      steps: [
        {
          name: "Deploy",
          failed: true,
          lines: ["one", "two", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
        },
      ],
    },
  });

  const [check] = await vcs.checks(REPO, "abc");
  const logs = officeCiLogs({ vcs, team: teamConfig(), log: silentLogger });
  return { vcs, logs, url: check!.url };
}

const refused = async (p: Promise<unknown>, code: string, text: string) => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );

  expect(e).toBeInstanceOf(ProtocolError);
  expect((e as ProtocolError).code).toBe(code);
  expect((e as ProtocolError).message).toContain(text);
};

describe("check logs through the office", () => {
  it("reads the failed steps of a check on a team repository, masked", async () => {
    const { logs, url } = await setup();
    expect(await logs.read("sam", { url, lines: 2 })).toEqual({
      repo: "acme/app",
      steps: [{ name: "Deploy", lines: ["two", "***"], omitted: 1 }],
    });
  });

  it("refuses a link that is no check, and a repository outside the team", async () => {
    const { vcs, logs } = await setup();
    await refused(
      logs.read("sam", { url: "https://elsewhere.example/x", lines: 5 }),
      "invalid",
      "is not the link",
    );

    const other = { host: "git.acme.example", owner: "other", name: "secret" };
    await vcs.seed.check(other, "def", {
      name: "build",
      status: "failure",
      log: { steps: [{ name: "Build", failed: true, lines: ["x"] }] },
    });

    const [check] = await vcs.checks(other, "def");
    await refused(
      logs.read("sam", { url: check!.url, lines: 5 }),
      "invalid",
      "not one of the team's",
    );
  });

  it("passes on why the code host refused, and refuses without log support", async () => {
    const { vcs, logs, url } = await setup();
    vcs.checkLog = () => Promise.reject(new PortError("forbidden", "needs Actions: read"));
    await refused(logs.read("sam", { url, lines: 5 }), "failed", "needs Actions: read");
    vcs.checkLog = () => Promise.reject(new PortError("not_found", "no such job"));
    await refused(logs.read("sam", { url, lines: 5 }), "not_found", "no such job");
    vcs.checkLog = () => Promise.reject(new Error("boom"));
    await expect(logs.read("sam", { url, lines: 5 })).rejects.toThrow("boom");

    const bare = officeCiLogs({ vcs: {}, team: teamConfig(), log: silentLogger });
    await refused(bare.read("sam", { url, lines: 5 }), "invalid", "is not the link");
  });
});
