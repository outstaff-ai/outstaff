import { PortError, repoKey } from "@outstaff/core";
import type { Logger, RepoRef } from "@outstaff/core";
import { describe, expect, it, vi } from "vitest";
import { REPO, setup } from "./test-support.js";

const LIBS: RepoRef = { host: "git.acme.example", owner: "acme", name: "libs" };

const twoRepos = {
  repos: [
    { name: "app", url: "git.acme.example/acme/app", kind: "primary" },
    { name: "libs", url: "git.acme.example/acme/libs", kind: "other" },
  ],
};

function recorder() {
  const lines: { level: string; message: string; fields: Record<string, unknown> }[] = [];
  const at =
    (level: string) =>
    (message: string, fields: Record<string, unknown> = {}) =>
      void lines.push({ level, message, fields });

  const logger: Logger = { debug() {}, info: at("info"), warn: at("warn"), error: at("error") };
  return { lines, logger };
}

/** Two repositories, of which acme/libs answers 404 while `broken.value` is set; records who was asked when. */
async function twoRepoIntake() {
  const { lines, logger } = recorder();
  const broken = { value: false };
  const asked: { at: number; repos: string[] }[] = [];
  const s = await setup({
    logger,
    teamExtra: twoRepos,
    pollIntervalMs: 1000,
    backoff: { baseMs: 1000, maxMs: 8000 },
  });

  const real = s.vcs.events.bind(s.vcs);
  vi.spyOn(s.vcs, "events").mockImplementation(async (repos, cursor) => {
    asked.push({ at: s.clock.now().getTime(), repos: repos.map((r) => r.name) });
    const readable = repos.filter((r) => !broken.value || repoKey(r) !== repoKey(LIBS));
    const page = await real(readable, cursor);
    const unread = readable.length < repos.length;
    const error = new PortError("not_found", "GET /repos/acme/libs/events: 404 Not Found");
    return unread ? { ...page, unread: [{ repo: LIBS, error }] } : page;
  });

  return { ...s, lines, broken, asked };
}

describe("a repository that cannot be read", () => {
  it("is backed off on its own while the other repositories are polled on schedule", async () => {
    const { intake, clock, vcs, events, lines, broken, asked } = await twoRepoIntake();
    broken.value = true;
    const start = clock.now().getTime();
    await intake.start();
    for (let poll = 0; poll < 8; poll++) {
      // Something new in acme/app before every poll: each one is read by the poll that follows it.
      await vcs.seed.pullRequest(REPO, { title: `Change ${poll}` });
      clock.advance(poll === 0 ? 0 : 1000);
      await vi.waitFor(() => expect(intake.polls().vcs?.count).toBe(poll + 1));
      expect(events).toHaveLength(poll + 1);
    }

    await intake.stop();
    expect(asked.map((a) => a.repos.includes("libs"))).toEqual([
      true, // 0s: fails, retry in 1s
      true, // 1s: fails, retry in 2s
      false,
      true, // 3s: fails, retry in 4s
      false,
      false,
      false,
      true, // 7s: fails, retry in 8s
    ]);

    expect(asked.every((a) => a.repos.includes("app"))).toBe(true);
    expect(asked.map((a) => a.at - start)).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000, 7000]);
    const warnings = lines.filter((l) => l.level === "warn");
    expect(warnings.map((l) => l.message)).toEqual([
      "intake: vcs poll of acme/libs failed (not_found), retrying in 1s",
      "intake: vcs poll of acme/libs failed (not_found), retrying in 2s",
      "intake: vcs poll of acme/libs failed (not_found), retrying in 4s",
      "intake: vcs poll of acme/libs failed (not_found), retrying in 8s",
    ]);

    expect(warnings[0]?.fields).toMatchObject({ repo: "acme/libs", code: "not_found" });
    expect(lines.filter((l) => l.level === "error")).toEqual([]);
  });

  it("is read again once its backoff runs out and it can be read, with what happened meanwhile", async () => {
    const { intake, vcs, events, lines, broken, asked, clock } = await twoRepoIntake();
    broken.value = true;
    await intake.pollOnce();
    await vcs.seed.pullRequest(LIBS, { title: "Bump" });
    broken.value = false;
    await intake.pollOnce();
    expect(asked.at(-1)?.repos).toEqual(["app"]);
    expect(events).toHaveLength(0);

    clock.advance(1000);
    await intake.start();
    clock.advance(0);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    await intake.stop();
    expect(events[0]?.event).toMatchObject({ type: "pr.opened" });
    expect(JSON.stringify(events[0]?.event)).toContain("libs");
    expect(lines.filter((l) => l.level === "info").map((l) => l.message)).toContain(
      "intake: vcs poll of acme/libs succeeded again",
    );

    // Recovered: no backoff left, so it is asked for on every poll again.
    expect(asked.at(-1)?.repos).toEqual(["app", "libs"]);
  });
});
