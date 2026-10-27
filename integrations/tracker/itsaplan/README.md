# @outstaff/integration.tracker.itsaplan

Its a Plan tracker adapter (`tracker/itsaplan`) for Outstaff: issues, columns mapped to canonical statuses, assignment, comments, labels, links, members and an event feed, over a typed REST client on the injected `fetch`.

The knowledge adapter (`knowledge/itsaplan`, the project's documents) is [`@outstaff/integration.knowledge.itsaplan`](../../knowledge/itsaplan/README.md). Both adapters run on [`@outstaff/integration.shared.itsaplan`](../../shared/itsaplan/README.md): the REST client, options, setup guide, doctor checks and secrets. Identity, self-hosted instances, the rate limit and errors are described there.

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

## Statuses

`team.workflow.statuses` maps each canonical status to a column name; unmapped statuses default to Title Case (`Backlog`, `Ready`, `Active`, `Review`, `Blocked`, `Done`, `Canceled`). Names match case-insensitively. When a project has no column of that name, the first column of the matching kind is used (`backlog`/`ready` to backlog or unstarted, `active`/`review`/`blocked` to started, `done` to completed, `canceled` to canceled). `Issue.status.canonical` is derived the same way in reverse.

## Tracker behaviour

- Issue keys are the identifier (`SHOP-12`); the key's project must be the configured one.
- Lists and search carry no description in the API, so each result is read in full (five at a time); `listIssues` and `search` cost one extra call per issue.
- Labels are created by name when missing. `link` kinds: `blocks`, `relates`, `duplicates`. The API has subtasks: `createIssue` with `parent` sends `parentId` (the parent's internal id) on the `POST`, and `setParent` (`ost ticket parent`) sends it with a `PATCH` and reads it back, throwing `unsupported` when the API leaves it unchanged. Either way the description starts with a `Part of <key>: <link>` line.
- `assign` and the `assignee` filter take a member id, a username or a display name.
- Events come from the project activity feed (`GET /projects/{project}/analytics/activity`, which needs the dashboards read permission). Mapped: `created`, status moves (`moved`), assignee changes (`assigned`) and comments (`commented`); everything else (labels, priority and so on) is skipped. `externalId` is `itsaplan:<activity id>`. The cursor is opaque (it holds the highest activity id seen); the first call without one returns the feed's history, oldest first, up to 2,000 entries.
- Comment URLs (`links.comment`) are the issue URL, because no comment anchor is documented; set `issue_comment_url` (variables `{url}`, `{workspace}`, `{project}`, `{key}`, `{commentId}`) when your instance has one. Documents work the same way with `doc_comment_url`.

## Tests

`pnpm test` runs the tracker contract kit against the adapter over the Its a Plan stand-in (`@outstaff/testing.itsaplan`), plus status mapping, events and links. `src/__tests__/live.test.ts` runs against a real scratch project only when `OUTSTAFF_TEST_ITSAPLAN_URL`, `OUTSTAFF_TEST_ITSAPLAN_PROJECT` and `ITSAPLAN_API_KEY` are set (optionally `OUTSTAFF_TEST_ITSAPLAN_API_URL` and `OUTSTAFF_TEST_ITSAPLAN_CA_FILE`); otherwise it shows as skipped. It creates issues in that project.
