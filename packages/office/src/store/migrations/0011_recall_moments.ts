import { type Kysely, SqliteAdapter, sql } from "kysely";
import type { Migration } from "kysely/migration";

/** Full-text search over the moments: Postgres keeps a tsvector beside the text, SQLite an FTS5 table. */
async function searchIndex(db: Kysely<unknown>): Promise<void> {
  if (db.getExecutor().adapter instanceof SqliteAdapter) {
    // A contentful FTS5 table keyed by the moment, kept in step by triggers (moments are only inserted and deleted).
    await sql`create virtual table recall_fts using fts5(key unindexed, text, tokenize = 'porter unicode61')`.execute(
      db,
    );

    await sql`create trigger recall_moments_ai after insert on recall_moments begin
      insert into recall_fts (key, text) values (new.key, new.text); end`.execute(db);

    await sql`create trigger recall_moments_ad after delete on recall_moments begin
      delete from recall_fts where key = old.key; end`.execute(db);

    return;
  }

  await sql`alter table recall_moments add column search tsvector
    generated always as (to_tsvector('english', text)) stored`.execute(db);

  await sql`create index recall_moments_search on recall_moments using gin (search)`.execute(db);
}

/** The moments the store already holds: every work item's title, its journal and the outcomes of its runs. */
async function backfill(db: Kysely<unknown>): Promise<void> {
  await sql`insert into recall_moments
      (key, person, at, kind, subject_type, subject_ref, work_item_id, actor, actor_name, text, url)
    select 'item:' || id, person, created_at, 'item', subject_type, subject_ref, id, null, null, title, null
    from work_items`.execute(db);

  await sql`insert into recall_moments
      (key, person, at, kind, subject_type, subject_ref, work_item_id, actor, actor_name, text, url)
    select 'journal:' || j.id, w.person, j.at, 'journal', w.subject_type, w.subject_ref, w.id, j.author, null,
      j.text, null
    from journal j join work_items w on w.id = j.work_item_id`.execute(db);

  await sql`insert into recall_moments
      (key, person, at, kind, subject_type, subject_ref, work_item_id, actor, actor_name, text, url)
    select 'outcome:' || r.id, w.person, r.finished_at, 'outcome', w.subject_type, w.subject_ref, w.id, w.person,
      null, r.outcome, null
    from runs r join work_items w on w.id = r.work_item_id
    where r.outcome is not null and r.finished_at is not null`.execute(db);
}

export const recallMoments: Migration = {
  async up(db: Kysely<unknown>) {
    // What `ost recall` searches: one row per moment of an agent's history. `person` is the agent it belongs to, or
    // null for an event about a ticket, pull request or document, which belongs to every agent whose work refers to it.
    await db.schema
      .createTable("recall_moments")
      .addColumn("key", "text", (c) => c.primaryKey())
      .addColumn("person", "text")
      .addColumn("at", "text", (c) => c.notNull())
      .addColumn("kind", "text", (c) => c.notNull())
      .addColumn("subject_type", "text")
      .addColumn("subject_ref", "text")
      .addColumn("work_item_id", "text")
      .addColumn("actor", "text")
      .addColumn("actor_name", "text")
      .addColumn("text", "text", (c) => c.notNull())
      .addColumn("url", "text")
      .execute();

    await db.schema
      .createIndex("recall_moments_person")
      .on("recall_moments")
      .columns(["person", "at"])
      .execute();

    await db.schema
      .createIndex("recall_moments_subject")
      .on("recall_moments")
      .columns(["subject_type", "subject_ref", "at"])
      .execute();

    await searchIndex(db);
    // Events are indexed by the office, which knows how to name their pull requests (it catches up on start).
    await backfill(db);
  },
};
