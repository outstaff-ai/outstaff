import { silentLogger, type AdapterContext } from "@outstaff/core";
import { trackerContract } from "@outstaff/core/contracts";
import { itsaplanTracker } from "../index.js";
import { trackerOptions } from "../index.js";
import type { TrackerOptions } from "../types.js";
import { createItsaplanTracker } from "../tracker.js";
import { API_KEY, createItsaplanFake, secretMap, team } from "@outstaff/testing.itsaplan";

const base = {
  secrets: secretMap({ ITSAPLAN_API_KEY: API_KEY }),
  team,
  log: silentLogger,
  now: () => new Date("2026-01-01T00:00:00Z"),
};

// The adapter against a stateful stand-in for the Its a Plan REST API, served over the injected fetch.
trackerContract("itsaplan (recorded fixtures)", async () => {
  const fake = createItsaplanFake();
  const ctx: AdapterContext<TrackerOptions> = {
    ...base,
    fetch: fake.fetch,
    options: trackerOptions.parse({
      url: "https://tracker.acme.example",
      api_url: "https://api.tracker.acme.example",
      project: "acme.SHOP",
    }),
  };

  const subject = await createItsaplanTracker(ctx);
  return {
    subject,
    seed: { ...fake.trackerSeed, forbiddenCall: () => subject.getIssue("SHOP-403") },
    capabilities: itsaplanTracker.capabilities,
  };
});
