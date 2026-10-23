---
title: "0007: Postgres and SQLite"
description: The office store supports both databases from the first release.
sidebar:
  order: 7
---

**Status:** accepted

## Context

The office keeps durable state:
- intake cursors and deduplication;
- the work-state graph;
- work items and runs;
- item journals;
- loop-guard counters;
- agent conversations.

Small teams want zero setup. Larger or long-lived teams, and a future dashboard, want a real database.

## Decision

- Postgres and SQLite are both supported from the first release.
- One store interface over Kysely, with one set of migrations. Dialect-specific code is kept isolated.
- A store contract suite runs against both in CI. Postgres runs as a service container.
- The store is rebuildable: if it is lost, cursors are rebuilt by rescanning the code host and tracker. Item journals are the only data that cannot be rebuilt, so back the store up.

## Consequences

- Features stick to the SQL subset both dialects support, or isolate the difference.
- The guides recommend Postgres for anything long-lived and SQLite on a volume for small setups.
