import type { DoctorCheck, SecretSource, TeamConfig } from "@outstaff/core";
import type { TeamCatalogs } from "../../types.js";
import type { Scope } from "../types.js";

export type Status = DoctorCheck["status"];

export interface ScopeReport {
  scope: string;
  checks: (DoctorCheck & { adapter?: string })[];
}

export interface DoctorSummary {
  ok: number;
  warn: number;
  fail: number;
}

/** The scope doctor checks, and what its checks read. */
export interface ScopeTarget {
  team: TeamConfig;
  handle: string;
  scope: Scope;
  person: TeamConfig["people"][number] | undefined;
  catalogs: TeamCatalogs | undefined;
  dir: string;
  secrets: SecretSource;
}
