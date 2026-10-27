import type { Db } from "#/store/schema.js";

export interface StoreInternals {
  db: Db;
  dialect: "postgres" | "sqlite";
  now: () => Date;
}
