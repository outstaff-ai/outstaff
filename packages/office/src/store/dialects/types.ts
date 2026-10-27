export interface PostgresOptions {
  /** Schema to keep the tables in (created if missing). Default: the connection's search_path. */
  schema?: string;
}
