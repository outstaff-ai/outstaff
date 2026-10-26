import type { DoctorCheck } from "@outstaff/core";

export type Status = DoctorCheck["status"];

export interface ScopeReport {
  scope: string;
  checks: (DoctorCheck & { adapter?: string })[];
}
