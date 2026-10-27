import type { AnyDef } from "../types.js";

export interface Configured {
  def: AnyDef;
  options: unknown;
}

export interface DeriveReport {
  written: string[];
  warnings: string[];
}
