import { describe, expect, it } from "vitest";
import { trackerRepoChecks } from "#/doctor/tracker-repos.js";
import { createFakeTracker } from "#/fakes/tracker.js";
import { PortError } from "#/ports/errors.js";

const team = {
  repos: [
    { name: "app", url: "https://git.acme.example/Acme/App.git", kind: "primary" },
    { name: "ops", url: "git.acme.example/acme/ops", kind: "infra" },
    { name: "docs", url: "git.acme.example/acme/docs", kind: "other" },
  ],
  people: [{ repos: { "kind:primary": "write", ops: "write", docs: "read" } }],
} as never;

describe("trackerRepoChecks", () => {
  it("says which writable repos the tracker can link pull requests of, and how to connect the others; a read-only repo is not checked", async () => {
    const tracker = createFakeTracker();
    await tracker.seed.repository!({ owner: "acme", name: "app" }, []);
    expect(await trackerRepoChecks(team, tracker)).toEqual([
      {
        name: "Tracker link of app",
        status: "ok",
        detail: "acme/app is connected to the tracker.",
      },
      {
        name: "Tracker link of ops",
        status: "warn",
        detail:
          "acme/ops is not connected to the tracker, so agents' pull requests in it are not shown on their tickets.",
        fix: "Connect the repository in the tracker's integrations, so the tracker can show agents' pull requests on their tickets.",
      },
    ]);
  });

  it("checks nothing for a tracker that cannot link pull requests, or a team without writable repos", async () => {
    expect(await trackerRepoChecks(team, {})).toEqual([]);
    expect(await trackerRepoChecks(team, undefined)).toEqual([]);
    expect(await trackerRepoChecks({ repos: [], people: [] }, createFakeTracker())).toEqual([]);
    const readOnly = {
      repos: [{ name: "docs", url: "git.acme.example/acme/docs", kind: "other" }],
      people: [],
    };

    expect(await trackerRepoChecks(readOnly as never, createFakeTracker())).toEqual([]);
  });

  it("leaves the repos not checked, saying why, when the tracker cannot tell", async () => {
    const tracker = {
      connectedRepositories: () =>
        Promise.reject(new PortError("not_found", "The project has no issue yet.")),
    };

    expect(await trackerRepoChecks(team, tracker)).toEqual([
      {
        name: "Tracker links not checked",
        status: "warn",
        detail:
          "The repositories connected to the tracker could not be read: The project has no issue yet.",
        fix: "Run the doctor again once that is fixed; until then, agents' pull requests may not show on their tickets.",
      },
    ]);
  });
});
