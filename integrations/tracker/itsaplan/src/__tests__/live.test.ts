import { describe, expect, it } from "vitest";
import { envSecretSource, silentLogger, type TeamConfig } from "@outstaff/core";
import { trackerContract } from "@outstaff/core/contracts";
import { itsaplanTracker } from "../index.js";

// Runs against a real instance and a scratch project. Set OUTSTAFF_TEST_ITSAPLAN_URL (web address),
// OUTSTAFF_TEST_ITSAPLAN_PROJECT (project key or team.KEY) and ITSAPLAN_API_KEY (a member of that project);
// optional OUTSTAFF_TEST_ITSAPLAN_API_URL and OUTSTAFF_TEST_ITSAPLAN_CA_FILE for self-hosted instances.
// The run creates issues in that project.
const url = process.env["OUTSTAFF_TEST_ITSAPLAN_URL"];
const project = process.env["OUTSTAFF_TEST_ITSAPLAN_PROJECT"];
const env = (k: string) => process.env[k];
const options = {
  url: url ?? "https://unset.invalid",
  project: project ?? "unset",
  ...(env("OUTSTAFF_TEST_ITSAPLAN_API_URL")
    ? { api_url: env("OUTSTAFF_TEST_ITSAPLAN_API_URL") }
    : {}),
  ...(env("OUTSTAFF_TEST_ITSAPLAN_CA_FILE")
    ? { ca_file: env("OUTSTAFF_TEST_ITSAPLAN_CA_FILE") }
    : {}),
};

const base = () => ({
  secrets: envSecretSource(),
  team: { people: [], integrations: {} } as unknown as TeamConfig,
  log: silentLogger,
  fetch,
  now: () => new Date(),
});

describe.skipIf(!url || !project)(
  "itsaplan live (set OUTSTAFF_TEST_ITSAPLAN_URL, OUTSTAFF_TEST_ITSAPLAN_PROJECT and ITSAPLAN_API_KEY to run)",
  () => {
    it("reads the project's members and issues", async () => {
      const tracker = await itsaplanTracker.create({
        ...base(),
        options: itsaplanTracker.options.parse(options),
      });

      expect((await tracker.members()).length).toBeGreaterThan(0);
      await expect(tracker.listIssues({ limit: 5 })).resolves.toBeInstanceOf(Array);
    });

    // No member-creating seed: the kit runs the cases that need none and skips the rest visibly.
    trackerContract("itsaplan (live)", async () => ({
      subject: await itsaplanTracker.create({
        ...base(),
        options: itsaplanTracker.options.parse(options),
      }),
      seed: {},
      capabilities: itsaplanTracker.capabilities,
    }));
  },
);
