# @outstaff/tracker-itsaplan

Its a Plan adapters for Outstaff, in one package over one typed REST client on the injected `fetch`:

- `tracker/itsaplan`: issues, columns mapped to canonical statuses, assignment, comments, labels, links, members and an event feed.
- `knowledge/itsaplan`: the project's document tree, markdown in and out of the editor's JSON, search, versions, inline comments, replies and resolve.

```yaml
integrations:
  tracker:
    adapter: itsaplan
    url: https://tracker.acme.example # web address, used for links
    project: SHOP # project key, or acme.SHOP when the key is not unique across your teams
    # api_url: https://api.tracker.acme.example   # default: the web address with `api.` in front of the host
    # ca_file: /etc/acme/ca.pem                   # CA of a self-hosted instance
    # agents: [sam, kit]                          # usernames that are agents, besides the team's people handles
    # issue_url: "{url}/{workspace}/issue/{key}"  # link templates; {url}, {workspace}, {project}, {key} / {id}
    # doc_url: "{url}/{workspace}/{project}/docs/{id}"
    # issue_comment_url / doc_comment_url: optional comment link templates; {commentId} too. Default: the parent's link
  knowledge:
    adapter: itsaplan # url, project, api_url, ca_file and agents fall back to the tracker integration
```

Setup (members for agents, emails, API keys) is in the [adapter guide](https://docs.outstaff.work/adapters/tracker-itsaplan/); the tracking issue for accounts-as-members is [#52](https://github.com/outstaff-ai/outstaff/issues/52).

## Identity: agents are members

Every agent is a normal member of the instance with its own API key, not an "AI agent" object, so people assign work to it in the UI like to anyone else. A container holds one secret:

| Key                | Scope          | Meaning                                                                      |
| ------------------ | -------------- | ---------------------------------------------------------------------------- |
| `ITSAPLAN_API_KEY` | person, office | API key of that container's member (Account settings > API keys, shown once) |

A key carries its owner's permissions. The office uses a member key of its own.

`Member.kind` is `agent` when the username (or name) is a handle in `team.people`, is listed in `agents`, or the instance flags the member as an AI agent; everyone else is `human`.

## Statuses

`team.workflow.statuses` maps each canonical status to a column name; unmapped statuses default to Title Case (`Backlog`, `Ready`, `Active`, `Review`, `Blocked`, `Done`, `Canceled`). Names match case-insensitively. When a project has no column of that name, the first column of the matching kind is used (`backlog`/`ready` to backlog or unstarted, `active`/`review`/`blocked` to started, `done` to completed, `canceled` to canceled). `Issue.status.canonical` is derived the same way in reverse.

## Tracker behaviour

- Issue keys are the identifier (`SHOP-12`); the key's project must be the configured one.
- Lists and search carry no description in the API, so each result is read in full (five at a time); `listIssues` and `search` cost one extra call per issue.
- Labels are created by name when missing. `link` kinds: `blocks`, `relates`, `duplicates`. The API has subtasks: `createIssue` with `parent` sends `parentId` (the parent's internal id) on the `POST`, and `setParent` (`ost ticket parent`) sends it with a `PATCH` and reads it back, throwing `unsupported` when the API leaves it unchanged. Either way the description starts with a `Part of <key>: <link>` line.
- `assign` and the `assignee` filter take a member id, a username or a display name.
- Events come from the project activity feed (`GET /projects/{project}/analytics/activity`, which needs the dashboards read permission). Mapped: `created`, status moves (`moved`), assignee changes (`assigned`) and comments (`commented`); everything else (labels, priority and so on) is skipped. `externalId` is `itsaplan:<activity id>`. The cursor is opaque (it holds the highest activity id seen); the first call without one returns the feed's history, oldest first, up to 2,000 entries.
- Comment URLs (`links.comment`) are the issue URL, because no comment anchor is documented; set `issue_comment_url` (variables `{url}`, `{workspace}`, `{project}`, `{key}`, `{commentId}`) when your instance has one. Documents work the same way with `doc_comment_url`.

## Knowledge behaviour

- A document's `path` is its location in the tree. It is stored in the page's `metadata.path`, so a title can differ from the last path segment; pages made in the web app resolve by the titles of their ancestors (`Handbook/Onboarding`, case-insensitive). `get` also accepts a numeric id.
- `create` makes missing parent pages (empty), and rejects an existing path with `conflict`.
- `update` sends `content` and `contentJson` together so the page stays commentable. Without `baseVersion` it edits the current version; a stale one is `conflict` (HTTP 409).
- Comment ids are `<documentId>:<commentId>`, because replying and resolving need the document. A top-level comment is anchored to `anchorText` (copied exactly from one paragraph); without it, the start of the first paragraph is used. A page written as markdown only is given its editor JSON on the first comment.
- Markdown support: headings, paragraphs, bullet, ordered and task lists (nested), blockquotes, fenced code, rules, tables, hard breaks, bold, italic, strike, inline code and links. Anything else degrades to plain text. `docToMd` writes the same subset back.

## Self-hosted instances and custom CAs

With `ca_file` the adapter makes its requests through an `undici` agent that trusts that PEM file in addition to the system roots. Without it the injected `fetch` is used as is, so you can also run the process with `NODE_EXTRA_CA_CERTS=/etc/acme/ca.pem`.

## Rate limit

The service limits each API key by burst, not per minute: about 100 requests are allowed while each comes within roughly a second of the previous one, and the next one answers HTTP 500 (not 429) until the key has been idle for about a second. The shared HTTP client therefore:

- paces every request per API key and host (the tracker and knowledge adapters of a process share one pacer): after 80 requests in a burst, the next waits until the key has been idle for 1.1 s, then a new burst starts;
- retries a `GET` (and `HEAD`, `PUT`, `DELETE`) once, after 1.2 s, when it gets a 500 in the middle of a burst, and logs it at warn as `rate limited`; a 500 on the first request after an idle period is a real failure and is not retried;
- never retries `POST` or `PATCH`, because it cannot tell whether the first attempt took effect; their 500 surfaces as `unavailable`.

Pacing is per process: several containers using the same key still share the service's budget, which is what the single retry covers.

## Errors

401 and 403 `forbidden`; 404 `not_found`; 409 `conflict` (stale document version, WIP limit); 429 `rate_limited` with `retryAfterMs` from `retry-after`; 400 and 422 `invalid`; 5xx and network failures `unavailable` (see Rate limit for the one 500 that is retried). The platform's `code` and message are kept in the error message.

## Tests

`pnpm test` runs the tracker and knowledge contract kits against the adapters over a stateful stand-in for the REST API (`src/testing/`), plus markdown round-trips, status mapping, events, errors and the CA path. `src/__tests__/live.test.ts` runs against a real scratch project only when `OUTSTAFF_TEST_ITSAPLAN_URL`, `OUTSTAFF_TEST_ITSAPLAN_PROJECT` and `ITSAPLAN_API_KEY` are set (optionally `OUTSTAFF_TEST_ITSAPLAN_API_URL` and `OUTSTAFF_TEST_ITSAPLAN_CA_FILE`); otherwise it shows as skipped. It creates issues and pages in that project.
