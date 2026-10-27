import type { Db } from "../schema.js";

export interface StoreInternals {
  db: Db;
  dialect: "postgres" | "sqlite";
  now: () => Date;
}
