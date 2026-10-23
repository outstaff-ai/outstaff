# @outstaff/office

The office service: one container that watches repositories and the tracker, schedules work for each agent, routes questions between agents, and keeps tickets and pull requests moving. Early development; nothing is released yet.

## Store

`openStore(url)` opens the office's durable state and runs migrations (`{ migrate: false }` to skip):

- `postgres://user:pass@host/db` for anything long-lived.
- `sqlite:///abs/path/office.db` or `sqlite::memory:` for small setups. SQLite uses Node's built-in `node:sqlite`, so there is no native addon to build.

Schema is portable SQL only: text, integers, ISO-8601 UTC timestamps as text, JSON as text. Work items run lowest `priority` number first, then oldest.

The store is rebuildable. If it is lost, intake cursors and the work-state graph are rebuilt by rescanning the code host and tracker. Item journals cannot be rebuilt, so back the store up. The contract suite tests this recovery.

Run the contract suite against Postgres locally with `OUTSTAFF_TEST_POSTGRES_URL=postgres://… pnpm test` (it is skipped with a warning otherwise; CI always runs it).
