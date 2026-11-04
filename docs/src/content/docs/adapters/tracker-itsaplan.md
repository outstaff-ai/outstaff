---
title: Its a Plan
description: Set up the Its a Plan tracker and knowledge adapters, with one member account per agent.
---

The `itsaplan` adapters implement two ports: the **tracker** (issues, columns, comments, labels, links, members and an event feed) in `@outstaff/integration.tracker.itsaplan`, and **knowledge** (the project's documents, with comments and their links on issues) in `@outstaff/integration.knowledge.itsaplan`. Both run on `@outstaff/integration.shared.itsaplan`, which holds the client, its rate-limit pacer, the options, setup and doctor checks; neither adapter depends on the other.

## Agents are members

Create every agent as a normal **member** of your Its a Plan instance, not as an "AI agent" object. Then people assign work to an agent in the UI exactly as they would to a colleague, and the agent acts with its own API key. `ost setup <handle>` prints these steps with your team's address scheme and `--derive` fills `ITSAPLAN_MEMBER_ID` ([Set up credentials](/guides/setup/)). Tracking issue: [#52](https://github.com/outstaff-ai/outstaff/issues/52).

For each person in `team.people`:

1. **Pick an email address for the agent.** No mailbox is run by Outstaff; use one you already control.
   - Plus-addressing on a human's mailbox (the default): `alex+sam@acme.example` delivers to `alex@acme.example`.
   - Or a forwarding scheme on a domain your team owns, for example Cloudflare Email Routing: `sam@agents.acme.example` forwarded to a human.
2. **Invite the address** to the team and the project (Team settings > Members, then the project's members). The invite email arrives in the human's inbox.
3. **A human accepts the invite** and sets up the account (name, avatar). Use the handle from `team.yaml` as the username, so Outstaff recognises the member as an agent.
4. **Create the agent's API key** while signed in as that member: Account settings > API keys. The key is shown once.
5. **Give the key to the agent's container** as the secret `ITSAPLAN_API_KEY` (a file under the secrets directory is preferred over an environment variable). The office needs a member of its own with the same kind of key. The office only reads with it: every change in Its a Plan is made by an agent, as itself.

The key has the permissions of its member, so give the member only the projects it works in. The member must be able to read the project's activity feed (the dashboards permission), which the office uses to see events. An agent's member also needs to edit the project's documents and work items, so it can link the documents it writes on their tickets.

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

| Option              | Meaning                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `url`               | Web address of the instance, used for links. Required on the tracker.                                                                |
| `project`           | Project key, or `<team>.<KEY>` when more than one of your teams has a project with that key. Required on the tracker.                |
| `api_url`           | API root. Defaults to the web address with `api.` in front of the host.                                                              |
| `ca_file`           | PEM file with the CA that signed a self-hosted instance's certificate.                                                               |
| `agents`            | Extra usernames that are agents. Members whose username is a handle in `team.people` are agents already.                             |
| `issue_url`         | Link template for issues, default `{url}/{workspace}/issue/{key}`.                                                                   |
| `doc_url`           | Link template for documents, default `{url}/{workspace}/{project}/docs/{id}`. Change it if your instance serves documents elsewhere. |
| `issue_comment_url` | Link template for one issue comment; also `{commentId}`. Unset, a comment links to its issue.                                        |
| `doc_comment_url`   | Link template for one document comment; also `{commentId}`. Unset, a comment links to its document.                                  |

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

- **Tracker:** read, list, search and create issues; edit their title and description (`ost ticket edit`); move them between columns by canonical status; assign; comment; set labels (missing labels are created); link issues (`blocks`, `relates`, `duplicates`) and unlink them; list members; poll the project activity feed with an opaque cursor.
- **Attachments** (capability `tracker.attachments`): upload a file to an issue (`ost ticket attach`, and the files of a chat message when a chat session files a ticket), and list and download the files attached to an issue. The agent downloads the images and small text files (up to 10 MB) attached to the tickets of its work item into the item's scratch directory and lists them in its prompt as data from whoever attached them; `ost ticket show` lists them too.
- **Pull request links** (capability `tracker.development`): an agent's pull request is linked on its ticket's Development section, by the agent with its own API key: by `ost pr open` as it opens it, else when the office sees it opened for the ticket or linked to it later (the `link_pr_on_ticket` policy). Its a Plan links only pull requests of repositories connected to the team (the team's GitHub or GitLab integration in Its a Plan); the office's doctor (`ost doctor --via-office`) warns about each repository in `repos:` that someone can write to and that is not connected. It lists the connected repositories per issue, so the check is made once the project has an issue. A pull request already linked is left as it is.
- **Usage fields** (capability `tracker.fields`): each ticket shows the agent tokens and API-equivalent cost of its work, sub-tickets rolled up, in two project custom fields of type number, "Agent tokens" and "Agent cost, USD (API-equivalent)" ([Tokens and cost per ticket](/architecture/office/#tokens-and-cost-per-ticket)). The agent whose round it was writes them with its own API key (`PUT /issues/{id}/fields/{fieldId}`), so its member needs to edit work items. `ost setup <handle|office> --derive` creates the fields when the project lacks them (`POST /projects/{key}/custom-fields`), which needs a key that may create custom fields; otherwise a project admin adds them by hand. The doctor warns while either is missing. `usage.tracker_fields: false` turns the fields off.
- **Document links** (capability `knowledge.issueLinks`): a document an agent writes for a ticket (`ost doc create` in a round on the ticket, or with `--ticket <key>`, or written in a chat session that `ost work attach` then attaches to the ticket) is linked on the ticket, by the agent with its own API key (the `link_doc_on_ticket` policy). A document already linked is left as it is. Linking needs the member to edit both the document and the work item (the `documents: edit` and `work items: edit` permissions); each agent's doctor (`ost doctor`) reads the links of a document with the agent's key, and warns when the key is refused, naming those permissions.
- **Agent notes** (capability `knowledge.notes`, used with `memory.store: knowledge`): each agent keeps its notes on a public page, `Agent notes/<name>`, created with its own key, so it owns the page and a human can read it. The notes are a Markdown list, one item per note. A version of the page is used only when the agent or a trusted human wrote it; for a version by anyone else the adapter reads the page's revisions (`GET /projects/{key}/documents/{id}/revisions`) for the newest one a trusted author wrote, and the agent is told about the change. Two agents creating the `Agent notes` page at once leave two; the oldest is used. With `store: knowledge`, each agent's doctor reads the project's documents with the agent's key: it fails when the key is refused, and warns when the notes page is private, so no human could review it. Creating the page needs the member to edit documents (`documents: edit`).
- **Milestones** (capability `tracker.initiatives`): the roadmap's milestones are the project's initiatives (`GET`/`POST /projects/{key}/initiatives`, `GET`/`PATCH /initiatives/{id}`), which the PM keeps with `ost milestone list|show|create|add|status`. Its a Plan's statuses map onto the port's: `proposed` and `planned` are planned, `active` is active, `completed` is done, `canceled` is canceled. A ticket is put in a milestone with the issue's `initiativeId` (on the `POST` with `ost ticket create --milestone <id>`, or a `PATCH` with `ost milestone add <id> --ticket <key>`), and a milestone's tickets are listed with `GET /projects/{key}/issues?initiativeId=`. A plan of later work is linked to its milestone with `ost milestone add <id> --doc <plan>` (`POST /projects/{key}/documents/{id}/initiatives`, read back with `GET /projects/{key}/documents/for-initiative/{id}`). Reading a ticket names its initiative, so the office knows each ticket's milestone, and the `milestone_done_to_pm` policy wakes the PM when the last open one closes. Making and changing initiatives needs the member to edit initiatives.
- **Sub-tickets:** `ost ticket create --parent <key>` (a planned part; a follow-up is a separate ticket with a `relates` link instead) is created as a real subtask (`parentId`); `ost ticket parent <key> <parent>` does the same for an existing ticket, and `ost ticket parent <key>... --clear` detaches tickets from their parent (`parentId: null`). Either way its description says nothing about the parent.
- **Dependencies:** `ost ticket create --blocked-by <key>` and `ost ticket link <key> --blocked-by|--blocks|--relates <other>` create Its a Plan links (`POST /issues/{id}/links`); `--remove` deletes them (`DELETE /issues/{id}/links/{linkId}`).
- **Knowledge:** a document tree addressed by path or id; search; create (missing parent pages are made); update with a version check (a stale `baseVersion` is a `conflict`); inline comments anchored to a quoted passage, replies and resolve. Markdown is converted to and from the editor's JSON.
- **Errors** map to the port error codes: 401 and 403 `forbidden`, 404 `not_found`, 409 `conflict`, 429 `rate_limited`, 400 and 422 `invalid`, 5xx and network failures `unavailable`.

More detail, including the supported markdown subset, is in the package README.
