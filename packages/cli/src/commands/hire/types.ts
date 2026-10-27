import type { SetupStep } from "@outstaff/core";
import type { NewPerson } from "../../types.js";

export type SetupJson = {
  file: string;
  secretsDir: string;
  keys: string[];
  guides: { adapter: string; steps: SetupStep[] }[];
  unsupported: string[];
};

export type Grants = NewPerson["repos"];

export type HireOptions = {
  name?: string;
  handle?: string;
  pronouns?: string;
  model?: string;
  avatar?: string;
  repos?: string;
  yes?: boolean;
  out?: string;
  secretsDir?: string;
};

/** The person `ost hire` is about to add, with what the summary and the steps after it need. */
export type ChosenPerson = {
  person: NewPerson;
  summary: string[];
  name: string;
  handle: string;
  seed: string;
  isUrl: boolean;
};
