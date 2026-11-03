# @outstaff/integration.knowledge.itsaplan

Its a Plan knowledge adapter (`knowledge/itsaplan`) for Outstaff: the project's document tree, markdown in and out of the editor's JSON, search, versions, inline comments, replies and resolve, and documents linked on issues.

It runs on the REST client, options, setup guide and doctor checks of [`@outstaff/integration.shared.itsaplan`](../../shared/itsaplan/README.md), which the tracker adapter uses too; identity, self-hosted instances and custom CAs, the rate limit and error mapping are described there. The two adapters of a process share one pacer per API key.

```yaml
integrations:
  tracker:
    adapter: itsaplan
    url: https://tracker.acme.example
    project: SHOP
  knowledge:
    adapter: itsaplan # url, project, api_url, ca_file and agents fall back to the tracker integration
    # doc_url: "{url}/{workspace}/{project}/docs/{id}"
    # doc_comment_url: optional comment link template; {commentId} too. Default: the document's link
```

Setup (members for agents, emails, API keys) is in the [adapter guide](https://docs.outstaff.work/adapters/tracker-itsaplan/).

## Knowledge behaviour

- A document's `path` is its location in the tree. It is stored in the page's `metadata.path`, so a title can differ from the last path segment; pages made in the web app resolve by the titles of their ancestors (`Handbook/Onboarding`, case-insensitive). `get` also accepts a numeric id.
- `create` makes missing parent pages (empty), and rejects an existing path with `conflict`.
- `update` sends `content` and `contentJson` together so the page stays commentable. Without `baseVersion` it edits the current version; a stale one is `conflict` (HTTP 409).
- Comment ids are `<documentId>:<commentId>`, because replying and resolving need the document. A top-level comment is anchored to `anchorText` (copied exactly from one paragraph); without it, the start of the first paragraph is used. A page written as markdown only is given its editor JSON on the first comment.
- `linkIssue` (capability `knowledge.issueLinks`) links a document on an issue: it reads the issue by its key for its internal id, lists the issues the document is linked on (`GET /projects/{key}/documents/{id}/issues`) and `POST`s `{ issueId }` there only when the issue is not among them; a `409` from a link made meanwhile counts as linked already. `issueDocs` lists an issue's documents (`GET /projects/{key}/documents/for-issue/{issueId}`). Linking needs the member to edit both the document and the issue (`documents: edit`, `work items: edit`); the doctor, run with an agent's key, reads the links of the project's first document and warns when the key is refused.
- `notes` (capability `knowledge.notes`) keeps each agent's notes on a public page `Agent notes/<owner name>`, created with the agent's key (so the agent owns it), as a Markdown list. `read` finds the oldest `Agent notes` top-level page and the oldest child with the owner's name; when the current version's author (`updatedByUserId`, else `createdByUserId`) is not one the caller trusts, it lists the page's revisions and reads the newest earlier one by a trusted author (`GET .../revisions/{id}`), and names the ignored version. `write` creates the page (and the root) when the caller read none, and otherwise `PATCH`es it with the version read (a `409` is `conflict`). With `memory.store: knowledge` the doctor, run with an agent's key, reads the project's documents, fails when refused and warns when the agent's page is private.
- Markdown support: headings, paragraphs, bullet, ordered and task lists (nested), blockquotes, fenced code, rules, tables, hard breaks, bold, italic, strike, inline code and links. Anything else degrades to plain text. `docToMd` writes the same subset back.

## Tests

`pnpm test` runs the knowledge contract kit against the adapter over the Its a Plan stand-in (`@outstaff/testing.itsaplan`) with this adapter's markdown conversion plugged in (`src/__tests__/fake.ts`), plus markdown round-trips, links and document comment events. `src/__tests__/live.test.ts` runs against a real scratch project only when `OUTSTAFF_TEST_ITSAPLAN_URL`, `OUTSTAFF_TEST_ITSAPLAN_PROJECT` and `ITSAPLAN_API_KEY` are set (optionally `OUTSTAFF_TEST_ITSAPLAN_API_URL` and `OUTSTAFF_TEST_ITSAPLAN_CA_FILE`); otherwise it shows as skipped. It creates pages in that project.
