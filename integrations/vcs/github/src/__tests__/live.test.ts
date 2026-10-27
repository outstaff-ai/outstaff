import { describe, expect, it } from "vitest";
import { parseRepoUrl, envSecretSource, silentLogger, type TeamConfig } from "@outstaff/core";
import { vcsContract } from "@outstaff/core/contracts";
import { githubVcs } from "#/index.js";

// Runs against a scratch repository with real Apps. Set OUTSTAFF_TEST_GITHUB_REPO (github.com/owner/name)
// plus GH_OFFICE_APP_ID and GH_OFFICE_APP_PRIVATE_KEY (or _FILE) for the read-only office App installed on it.
// Optional: OUTSTAFF_TEST_GITHUB_API_URL / OUTSTAFF_TEST_GITHUB_WEB_URL for Enterprise.
const target = process.env["OUTSTAFF_TEST_GITHUB_REPO"];
const repo = parseRepoUrl(target ?? "github.com/unset/unset");
const build = () =>
  githubVcs.create({
    options: githubVcs.options.parse({
      ...(process.env["OUTSTAFF_TEST_GITHUB_API_URL"]
        ? { apiUrl: process.env["OUTSTAFF_TEST_GITHUB_API_URL"] }
        : {}),
      ...(process.env["OUTSTAFF_TEST_GITHUB_WEB_URL"]
        ? { webUrl: process.env["OUTSTAFF_TEST_GITHUB_WEB_URL"] }
        : {}),
    }),
    secrets: envSecretSource(),
    team: { people: [] } as unknown as TeamConfig,
    log: silentLogger,
    fetch,
    now: () => new Date(),
  });

describe.skipIf(!target)(
  "github live (set OUTSTAFF_TEST_GITHUB_REPO and the GH_OFFICE_APP_* secrets to run)",
  () => {
    it("reads pull requests and checks the permission API", async () => {
      const vcs = await build();
      const ref = { owner: repo.owner, name: repo.name };
      await expect(vcs.listPullRequests(ref, { state: "all" })).resolves.toBeInstanceOf(Array);
      expect(await vcs.permission(ref, "outstaff-no-such-user-xyz")).toBe("none");
      const events = await vcs.events([ref]);
      expect((await vcs.events([ref], events.cursor)).events).toEqual([]);
    });

    // No seed hooks: the kit runs the cases that need no seeded data and skips the rest.
    vcsContract("github (live)", async () => ({
      subject: await build(),
      seed: { repo: { owner: repo.owner, name: repo.name } },
      capabilities: githubVcs.capabilities,
    }));
  },
);
