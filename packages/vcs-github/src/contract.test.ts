import { vcsContract } from "@outstaff/core/contracts";
import { silentLogger } from "@outstaff/core";
import { githubVcs } from "./index.js";
import { createGithubVcs } from "./vcs.js";
import { createGithubFake, OFFICE_APP, OWN_APP } from "./testing/github-fake.js";
import { ORIGIN, secretMap, team } from "./testing/harness.js";
import { testKey } from "./testing/keys.js";
import { githubOptions } from "./options.js";

// An agent container for "sam": its own App plus the read-only office App.
const secrets = {
  GH_OFFICE_APP_ID: String(OFFICE_APP),
  GH_OFFICE_APP_PRIVATE_KEY: testKey.privateKey,
  GH_APP_ID: String(OWN_APP),
  GH_APP_PRIVATE_KEY: testKey.privateKey,
  OUTSTAFF_PERSON: "sam",
};

// The adapter against a stateful GitHub stand-in served over the injected fetch.
vcsContract("github (recorded fixtures)", async () => {
  const fake = createGithubFake();
  const subject = createGithubVcs(
    {
      options: githubOptions.parse({ apiUrl: ORIGIN, webUrl: "https://github.example" }),
      secrets: secretMap(secrets),
      team,
      log: silentLogger,
      fetch: fake.fetch,
      now: () => new Date("2026-01-01T00:00:00Z"),
    },
    { sleep: async () => {} },
  );

  fake.bind(subject);
  return { subject, seed: fake.seed, capabilities: githubVcs.capabilities };
});
