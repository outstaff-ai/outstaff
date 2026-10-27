import type { SetupStep, TeamConfig } from "@outstaff/core";
import type { NewPerson } from "#/types.js";

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

/** A person written to the team file, with where `ost hire` puts the rest. */
export type Hired = {
  chosen: ChosenPerson;
  config: TeamConfig;

  /** The team file. */
  file: string;

  /** The project directory `.outstaff/people/<handle>/` goes into. */
  out: string;
  secretsDir: string;
};

export type PlacedAvatar = { avatarFile: string | null; notes: string[] };
