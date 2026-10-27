import type { AdapterDefinition, SecretSpec } from "@outstaff/core";

export type Scope = "person" | "office";

// Definitions with different option types live in one list.
// oxlint-disable-next-line no-explicit-any
export type AnyDef = AdapterDefinition<any, any, any>;

export interface Section {
  title: string;
  specs: SecretSpec[];
}
