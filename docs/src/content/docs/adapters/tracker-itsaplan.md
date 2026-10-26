---
title: Its a Plan
description: Set up the Its a Plan tracker and knowledge adapters, with one member account per agent.
---

The `itsaplan` adapter implements two ports from one package, `@outstaff/tracker-itsaplan`: the **tracker** (issues, columns, comments, labels, links, members and an event feed) and **knowledge** (the project's documents, with comments).

## Agents are members

Create every agent as a normal **member** of your Its a Plan instance, not as an "AI agent" object. Then people assign work to an agent in the UI exactly as they would to a colleague, and the agent acts with its own API key. `ost setup <handle>` prints these steps with your team's address scheme and `--derive` fills `ITSAPLAN_MEMBER_ID` ([Set up credentials](/guides/setup/)). Tracking issue: [#52](https://github.com/outstaff-ai/outstaff/issues/52).

For each person in `team.people`:

1. **Pick an email address for the agent.** No mailbox is run by Outstaff; use one you already control.
   - Plus-addressing on a human's mailbox (the default): `alex+sam@acme.example` delivers to `alex@acme.example`.
   - Or a forwarding scheme on a domain your team owns, for example Cloudflare Email Routing: `sam@agents.acme.example` forwarded to a human.
2. **Invite the address** to the team and the project (Team settings > Members, then the project's members). The invite email arrives in the human's inbox.
3. **A human accepts the invite** and sets up the account (name, avatar). Use the handle from `team.yaml` as the username, so Outstaff recognises the member as an agent.
4. **Create the agent's API key** while signed in as that member: Account settings > API keys. The key is shown once.
5. **Give the key to the agent's container** as the secret `ITSAPLAN_API_KEY` (a file under the secrets directory is preferred over an environment variable). The office needs a member of its own with the same kind of key.

The key has the permissions of its member, so give the member only the projects it works in. The member must be able to read the project's activity feed (the dashboards permission), which the office uses to see events.

## Configure

```yaml
integrations:
  tracker:
    adapter: itsaplan
    url: https://tracker.acme.example
    project: SHOP
  knowledge:
    adapter: itsaplan # takes url and project from the tracker
workflow:
  statuses:
    active: In Progress
    review: In Review
```

| Option      | Meaning                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `url`       | Web address of the instance, used for links. Required on the tracker.                                                                |
| `project`   | Project key, or `<team>.<KEY>` when more than one of your teams has a project with that key. Required on the tracker.                |
| `api_url`   | API root. Defaults to the web address with `api.` in front of the host.                                                              |
| `ca_file`   | PEM file with the CA that signed a self-hosted instance's certificate.                                                               |
| `agents`    | Extra usernames that are agents. Members whose username is a handle in `team.people` are agents already.                             |
| `issue_url` | Link template for issues, default `{url}/{workspace}/issue/{key}`.                                                                   |
| `doc_url`   | Link template for documents, default `{url}/{workspace}/{project}/docs/{id}`. Change it if your instance serves documents elsewhere. |

Link templates may use `{url}` (the web address without a trailing slash), `{workspace}`, `{project}` and `{key}` (issues) or `{id}` (documents). `{workspace}` is the team's segment in web URLs (the project's `teamRef`, its slug or id); the adapter reads it from the project the first time it needs it (never at start, so an unreachable instance does not stop the office) and retries with a backoff after a failure. Until it is known, default templates fall back to the shape without the workspace and a warning is logged once; explicit templates without `{workspace}` are not affected. It never has to be configured. A real instance serves `https://tracker.acme.example/acme/issue/SHOP-12` and `https://tracker.acme.example/acme/SHOP/docs/3`. `ost doctor` prints one issue link and one doc link to click, and fails when the workspace cannot be determined.

The knowledge integration can repeat any of these; what it leaves out comes from the tracker integration when that is `itsaplan` too.

Statuses come from `workflow.statuses`. A canonical status without a name defaults to its Title Case form (`Backlog`, `Ready`, `Active`, `Review`, `Blocked`, `Done`, `Canceled`), matched to the project's columns case-insensitively. If the project has no such column, the first column of the matching kind is used.

## Self-hosted instances with a private CA

Either set `ca_file` on the integration, or start the office and agent processes with `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`. `ca_file` adds the CA to the system roots for this adapter's requests only.

## Rate limit

Its a Plan answers HTTP 500 (not 429) once a key has made about 100 requests in close succession, until the key has been idle for about a second. The adapter paces each key to 80 requests per burst, waiting for the idle time when the budget is used, and retries a `GET` once after 1.2 s if a 500 arrives mid-burst anyway (logged at warn as `rate limited`). `POST` and `PATCH` are never retried.

## Secrets

| Key                | Scope          | Meaning                                       |
| ------------------ | -------------- | --------------------------------------------- |
| `ITSAPLAN_API_KEY` | person, office | API key of the member this container acts as. |

## What it does

- **Tracker:** read, list, search and create issues; move them between columns by canonical status; assign; comment; set labels (missing labels are created); link issues (`blocks`, `relates`, `duplicates`); list members; poll the project activity feed with an opaque cursor.
- **Attachments** (capability `tracker.attachments`): upload a file to an issue (`ost ticket attach`, and the files of a chat message when a chat session files a ticket), and list and download the files attached to an issue. The agent downloads the images and small text files (up to 10 MB) attached to the tickets of its work item into the item's scratch directory and lists them in its prompt as data from whoever attached them; `ost ticket show` lists them too.
- **Sub-tickets:** the project has no parent field, so `ost ticket create --parent <key>` starts the new ticket's description with a `Part of <key>: <link>` line and also links the two with `relates`.
- **Knowledge:** a document tree addressed by path or id; search; create (missing parent pages are made); update with a version check (a stale `baseVersion` is a `conflict`); inline comments anchored to a quoted passage, replies and resolve. Markdown is converted to and from the editor's JSON.
- **Errors** map to the port error codes: 401 and 403 `forbidden`, 404 `not_found`, 409 `conflict`, 429 `rate_limited`, 400 and 422 `invalid`, 5xx and network failures `unavailable`.

More detail, including the supported markdown subset, is in the package README.
