# @outstaff/core

The shared foundation of Outstaff: the team config schema and loader, the renderer that turns a team definition into runnable setups, access policies, and the port interfaces that adapters implement. Early development; nothing is released yet.

## Writing an adapter

An adapter is a package that implements one port for one product (for example a tracker adapter for your issue tracker). Outstaff talks to the outside world only through ports, so nothing else in the framework changes when you add one.

### Ports

| Port        | What it does                                                                  | Capabilities                                                                              |
| ----------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `tracker`   | issues, comments, assignment, status moves, events                            | `tracker.issues`, `tracker.assign`, `tracker.webhooks`                                    |
| `knowledge` | documents, search, comments                                                   | `knowledge.docs`                                                                          |
| `vcs`       | pull requests, checks, review threads, repo credentials, permissions, events  | `vcs.pullRequests`, `vcs.reviewThreads`, `vcs.workflows`, `vcs.reactions`, `vcs.webhooks` |
| `chat`      | inbound messages (trust-filtered), posting, reactions, history, agent profile | `chat.messages`, `chat.history`, `chat.agentProfile`                                      |
| `runtime`   | runs an LLM session under a permission `Policy` and streams events            | `runtime.sessions`, `runtime.usage`                                                       |
| `avatars`   | deterministic avatar images                                                   | `avatars.generate`                                                                        |

The interfaces live in `src/ports/` and are exported from `@outstaff/core`. `tracker` and `knowledge` are optional for a team; `vcs`, `chat` and `runtime` are required.

### defineAdapter

```ts
import { z } from "zod";
import { defineAdapter, PortError, type Tracker } from "@outstaff/core";

export const acmeTracker = defineAdapter({
  port: "tracker",
  name: "acme-tracker",
  capabilities: ["tracker.issues", "tracker.assign"],
  options: z.strictObject({ url: z.url(), project: z.string() }),
  secrets: (scope) =>
    scope === "office"
      ? [
          {
            key: "ACME_TRACKER_TOKEN",
            description: "API token for the office",
            where: "Settings > API tokens in your tracker",
          },
        ]
      : [],
  create({ options, secrets, team, fetch, log, now }): Tracker {
    const token = secrets.require("ACME_TRACKER_TOKEN");
    // build the Tracker from options.url, token and team.workflow.statuses
  },
});
```

`defineAdapter` returns the definition unchanged and registers `options` with the config validator, so a bad `integrations.tracker` block in `team.yaml` is reported as a config error before anything runs. Put definitions in an `AdapterRegistry`; `registry.toValidationAdapters()` gives `validateTeam` the adapter names and capabilities it checks.

### Secrets

`secrets(scope)` declares what the adapter needs (`"person"` for per-agent secrets, `"office"` for the office), with a description and where to get it. `ost setup` shows this to the person doing the setup, and `derivable: true` marks values `ost setup --derive` can compute. At runtime read them through `ctx.secrets` (`get` or `require`). `envSecretSource()` reads the environment first and then `/run/secrets/outstaff/<KEY>`. Never read `process.env` directly and never log a secret.

### Capabilities

List only what the adapter really supports. Methods behind a capability you do not declare may be left out (`chat.setAgentProfile`, `runtime.probeUsage`) or may reject with `unsupported`. The contract kits only exercise gated methods when the capability is declared, and `validateTeam` warns when a role needs a capability the configured adapter lacks.

### PortError

Map every platform failure to a `PortError` so callers never see platform types:

```ts
throw new PortError("rate_limited", "Too many requests", { retryAfterMs: 30_000 });
```

Codes: `not_found`, `forbidden`, `conflict`, `rate_limited`, `unavailable`, `invalid`, `unsupported`. Use `conflict` for stale `baseVersion` and duplicates, and set `retryAfterMs` when the platform tells you.

### Cursors and events

Every `events()` takes an opaque `cursor?: string` and returns `{ events, cursor }`. The office stores the cursor and passes it back next time. Each event carries a stable `externalId` so a replay is deduplicated. Return events in chronological order, and never return the same event on a later page.

### Links

Ports with addressable things expose `links`, which return absolute URLs (`links.issue(key)`, `links.doc(id)`, `links.pr(repo, number)`, `links.commit(repo, sha)`, `links.thread(repo, number, threadId)`). Every message the framework writes uses them, so people can click through. `parseRepoUrl("github.com/acme/app")` turns a team repo URL (host/owner/name, `https://` or `git@`) into a `RepoRef`.

### Contract kits and fakes

`@outstaff/core/contracts` has one kit per port (`trackerContract`, `knowledgeContract`, `vcsContract`, `chatContract`, `runtimeContract`, `avatarsContract`). `@outstaff/core/fakes` has an in-memory fake for each (`createFakeTracker`, ...) and `createFakeAdapterRegistry()`. The kits need `vitest`, an optional peer dependency used only by that subpath.

A kit takes a name and a `setup` function, called before every test. It returns the `subject`, the `capabilities` you declare, and a `seed` that lets the kit create the data it needs. Seed functions you cannot provide are left out and the kit skips those cases.

```ts
import { trackerContract } from "@outstaff/core/contracts";
import { createFakeTracker } from "@outstaff/core/fakes";
import { acmeTracker } from "./index.js";

// the in-memory fake passes the same kit
trackerContract("fake", async () => {
  const subject = createFakeTracker();
  return { subject, seed: subject.seed, capabilities: ["tracker.issues", "tracker.assign"] };
});

// your adapter, against a real sandbox project, only when credentials are present
if (process.env.ACME_TRACKER_TOKEN) {
  trackerContract("acme-tracker", async () => ({
    subject: await acmeTracker.create(await sandboxContext()),
    seed: { member: createSandboxMember },
    capabilities: acmeTracker.capabilities,
  }));
}
```

Application tests should use the fakes instead of real services. For example, `createFakeRuntime()` records every `RunRequest` and applies the request's policy to scripted tool calls, so a test can assert the permission decisions.
