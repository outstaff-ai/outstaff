import { silentLogger, type AdapterContext } from "@outstaff/core";
import { knowledgeContract, trackerContract } from "@outstaff/core/contracts";
import { itsaplanKnowledge, itsaplanTracker } from "../index.js";
import { createItsaplanKnowledge } from "../knowledge.js";
import {
  knowledgeOptions,
  trackerOptions,
  type KnowledgeOptions,
  type TrackerOptions,
} from "../options.js";
import { createItsaplanTracker } from "../tracker.js";
import { secretMap, team } from "../testing/harness.js";
import { API_KEY } from "../testing/http-stub.js";
import { createItsaplanFake } from "../testing/itsaplan-fake.js";

const base = {
  secrets: secretMap({ ITSAPLAN_API_KEY: API_KEY }),
  team,
  log: silentLogger,
  now: () => new Date("2026-01-01T00:00:00Z"),
};

// Both adapters against a stateful stand-in for the Its a Plan REST API, served over the injected fetch.
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

knowledgeContract("itsaplan (recorded fixtures)", async () => {
  const fake = createItsaplanFake();
  const ctx: AdapterContext<KnowledgeOptions> = {
    ...base,
    fetch: fake.fetch,
    // No options of its own: url and project come from the tracker integration, as in the acme example.
    options: knowledgeOptions.parse({ api_url: "https://api.tracker.acme.example" }),
  };

  const subject = await createItsaplanKnowledge(ctx);
  return {
    subject,
    seed: { ...fake.knowledgeSeed, forbiddenCall: () => subject.get("403") },
    capabilities: itsaplanKnowledge.capabilities,
  };
});
