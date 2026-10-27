import { silentLogger, type AdapterContext } from "@outstaff/core";
import { knowledgeContract } from "@outstaff/core/contracts";
import { knowledgeOptions } from "#/index.js";
import type { KnowledgeOptions } from "#/types.js";
import { API_KEY, secretMap, team } from "@outstaff/testing.itsaplan";
import { createItsaplanFake } from "./fake.js";
import { itsaplanKnowledge } from "#/index.js";
import { createItsaplanKnowledge } from "#/knowledge.js";

const base = {
  secrets: secretMap({ ITSAPLAN_API_KEY: API_KEY }),
  team,
  log: silentLogger,
  now: () => new Date("2026-01-01T00:00:00Z"),
};

// The adapter against a stateful stand-in for the Its a Plan REST API, served over the injected fetch.
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
