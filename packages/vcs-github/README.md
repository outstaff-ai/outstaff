# @outstaff/vcs-github

GitHub adapter (`vcs/github`) for Outstaff. Pull requests, checks, review threads, repo credentials, collaborator permissions and event polling, over a small typed REST and GraphQL client on the injected `fetch`. No Octokit.

```yaml
integrations:
  vcs:
    adapter: github
    # apiUrl: https://ghe.acme.example/api/v3   # GitHub Enterprise Server (default https://api.github.com)
    # webUrl: https://ghe.acme.example          # used for links (default https://github.com)
    # graphqlUrl: ...                           # derived from apiUrl when omitted
```

## Identities: who opened a pull request

The adapter recognizes a person's pull requests and events only by the exact login written in `team.yaml`, compared without regard to case. It never guesses from an App slug or a handle.

```yaml
humans:
  - { name: Alex, identities: { vcs: alex } } # a GitHub login
people:
  - handle: sam
    identities: { vcs: acme-sam, [bot] } # the person's App: <slug>[bot]
```

- A pull request or event by `acme-sam[bot]` belongs to `sam`, even though the handle and the slug differ. `sam[bot]` is then just another bot.
- Any other `[bot]` login is a bot, and a login that no one declares is an unknown human. Their text is data, never instructions, and they are trusted only as a repo writer or a listed human.
- `ost validate` warns (`people.missing_vcs_identity`) when a person has a write grant but no `identities.vcs`.

## Identity: two GitHub Apps

Nobody holds anyone else's key. Each container holds only the Apps it needs:

| App                                                            | Held by                                        | Can do                                                                                                                  |
| -------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| the person's **own App** (`<slug>[bot]`)                       | that person's container only                   | push branches, open and update pull requests, comment, resolve review threads, all as `<slug>[bot]`                     |
| the team's **read-only office App** (`<team>-outstaff-office`) | the office container and every agent container | read repositories, pull requests, checks, review threads, events and collaborator permissions; clone read-granted repos |

**Why agents also hold the read-only App.** An agent clones the repos it has read grants for, and its own App is installed only on the repos it may write to. The office App is the one identity with read access across the team's repos, and having no write permission it cannot be misused to change anything, so handing it to every container is safe. It also keeps all read traffic (polling, listing, checks) off the person Apps' rate-limit budgets.

### Which people need an App

Credentials follow a person's repository grants (`people[].repos`, resolved by repo name, `kind:<kind>` and `*`, to the repositories the team lists):

| The person has                  | Office App (`GH_OFFICE_APP_*`) | Own App (`GH_APP_*`) |
| ------------------------------- | ------------------------------ | -------------------- |
| no grant on any repository      | not needed                     | not needed           |
| read grants only                | required                       | optional             |
| a write grant on any repository | required                       | required             |

The office container always holds the office App. An optional own App is used when present, for example to comment on or review pull requests as the person.

A person with no grants has no GitHub identity: their agent starts without the `vcs` port (not an error), `ost setup` lists no GitHub keys, `ost doctor` skips GitHub, and the `ost pr` verbs refuse with "<handle> has no GitHub identity; ask a human or a teammate with repository access". Their tickets are still tracked by the office. `ost validate` warns when a person in the `reviewer` role has no repo grant or no `identities.vcs`, since reviewing pull requests is that role's job. `secrets("person")` without a person (container-contract table, secret scrubbing) lists every key.

### What `Vcs` does with them

- `credentials(person, repo, "read")`: a token from the office App, narrowed to that one repository with `contents: read`. Issued only to a person with a read or write grant on that repo in `team.yaml` (by repo name, `kind:<kind>` or `*`, resolved with core's `repoGrant`); anyone else is `forbidden`.
- `credentials(person, repo, "write")`: a token from the container's own App, narrowed to the repository with `contents`, `pull_requests` and `issues` write, plus the git author `<slug>[bot]` / `<id>+<slug>[bot]@users.noreply.<host>` (the id comes from `GET /users/<slug>[bot]`). Only when `person` has a write grant on the repo and is the person this container runs as (`OUTSTAFF_PERSON`); for anyone else, and always in the office container (which has no own App), it is `forbidden`. A permission GitHub will not grant (App not installed on the repo, permission missing) is also `forbidden`.
- `listPullRequests`, `getPullRequest`, `checks`, `reviewThreads`, `events`, `permission`: office App.
- `resolveThread(repo, id, asLogin?)`: `asLogin` defaults to this container's own bot login (`<slug>[bot]`); refuses unless the last comment is `asLogin`'s, then requires `asLogin` to be this container's own bot login (`forbidden` otherwise, and in a container without an own App), and resolves with the own App's token.

Installation tokens are cached and reused until five minutes before they expire. Tokens are never broader than the request. The JWT (RS256) is signed with `node:crypto`; there is no `jsonwebtoken` or `openssl` dependency.

### App permissions

| App                | Repository permissions                                                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| office (read-only) | Contents: read, Pull requests: read, Checks: read, Commit statuses: read, Issues: read, Metadata: read (collaborator permissions may need Administration: read on some orgs) |
| person (own)       | Contents: write, Pull requests: write, Issues: write, Checks: read, Metadata: read                                                                                           |

### Secrets

`secrets("person", { team, person })` lists the set that person needs (see above), `secrets("person")` both sets, `secrets("office")` only the office set.

| Key                                                            | Scope          | Meaning                                               | Derivable                                                    |
| -------------------------------------------------------------- | -------------- | ----------------------------------------------------- | ------------------------------------------------------------ |
| `GH_APP_ID`                                                    | person         | numeric id of the person's own App                    | no                                                           |
| `GH_APP_PRIVATE_KEY` / `GH_APP_PRIVATE_KEY_FILE`               | person         | PEM text (`\n` escapes accepted) or a path to the PEM | no                                                           |
| `GH_APP_INSTALLATION_ID`                                       | person         | installation of the own App                           | yes, `GET /app/installations` matched against the repo owner |
| `GH_APP_SLUG`                                                  | person         | own App slug                                          | yes, `GET /app`                                              |
| `GH_OFFICE_APP_ID`                                             | person, office | numeric id of the office App                          | no                                                           |
| `GH_OFFICE_APP_PRIVATE_KEY` / `GH_OFFICE_APP_PRIVATE_KEY_FILE` | person, office | PEM text or path                                      | no                                                           |
| `GH_OFFICE_APP_INSTALLATION_ID`                                | person, office | installation of the office App                        | yes                                                          |
| `GH_OFFICE_APP_SLUG`                                           | person, office | office App slug                                       | yes                                                          |

## Command permissions

The adapter contributes a rule pack for the `gh` CLI (`githubVcs.permissions()`, collected by `AdapterRegistry.rulePacks()` and merged by core's `buildPolicy({ packs })`). Core itself knows nothing about `gh`.

| Command          | Decision                                               |
| ---------------- | ------------------------------------------------------ |
| any `gh` command | denied (rule `gh.denied`); agents use `ost pr` instead |

Agents hold no GitHub token: git gets short-lived tokens from the `ost git-credential` helper, and `GH_TOKEN` and `GITHUB_TOKEN` are scrubbed. The `gh` CLI does not use git credential helpers for API calls, so it could not authenticate anyway; the rule keeps agents from reaching for it.

## What it implements

- Pull requests: list (paginated, author filter), get, `mergeable` mapped to `clean | conflicting | unknown`, `author.kind` (`agent` when the login is a person's `identities.vcs`, `bot` for any other `[bot]` login, `human` otherwise).
- `getPullRequest(..., { waitForMergeable: true })` re-reads a `null` mergeability up to five more times with backoff (0.5s, 1s, 2s, 3s, 5s). Closed and merged pull requests are not retried.
- Checks: check runs plus legacy commit statuses.
- Review threads: exactly three fixed GraphQL documents (list threads with comments, read the last comment of a thread, resolve). Logins are compared without the `[bot]` suffix, since GraphQL leaves it off.
- Permissions: collaborator permission mapped to `admin | write | read | none` (`maintain` is `write`, `triage` is `read`).
- Events: `pr.opened` (also reopened, with `data.reopened`), `pr.closed`, `pr.merged`, `pr.synchronize`, `pr.review_submitted`, `pr.comment` (review comments and comments on pull requests). `externalId` is the GitHub event id.
- Links: pull request, commit and thread URLs from `webUrl`.
- Errors: 404 `not_found`; 401/403 `forbidden`; 429, or 403 with `retry-after`, `x-ratelimit-remaining: 0` or a "rate limit" message, `rate_limited` with `retryAfterMs`; 409 `conflict`; 400/422 `invalid`; 5xx and network failures `unavailable`.

Webhook payload parsing (`vcs.webhooks`) is not implemented yet, so the capability is not declared.

## Rate limits and polling

- `events()` polls `GET /repos/{owner}/{repo}/events` with `If-None-Match`. A `304` costs no rate limit, so polling every few seconds is cheap while nothing happens.
- The cursor is an opaque string (JSON of `{ "owner/name": { etag, lastEventId } }`). Store it and pass it back. The first call without a cursor returns the repo's recent events (up to the last 300 that GitHub keeps); start the office from a stored cursor if you do not want to replay them.
- GitHub's Events API lags real activity by a few minutes and only keeps recent events. It is a polling fallback; use webhooks for latency-sensitive setups.
- Installation tokens are limited per installation (5,000 requests per hour, more on large orgs). Each App has its own budget; reads on the office App leave the person Apps' budgets for writing.
- When GitHub rate-limits a call the adapter throws `PortError("rate_limited")` with `retryAfterMs` taken from `retry-after`, or from `x-ratelimit-reset`, or 60 seconds for secondary limits. It does not sleep or retry on its own.

## Tests

`pnpm test` runs the vcs contract kit against the adapter backed by a recorded-fixture HTTP fake (`src/testing/`), plus unit tests for JWT signing (verified with a generated key), token caching, ETag/304, the mergeable retry and the resolve refusal. `src/live.test.ts` runs against a real scratch repository only when `OUTSTAFF_TEST_GITHUB_REPO` (for example `github.com/acme/scratch`) and the `GH_OFFICE_APP_*` secrets are set; otherwise it shows as skipped.
